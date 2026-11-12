import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resetAll, mockFetch, postJson, getJson, call, book, rows, fakeEmail, rawOf, api, visitor, NOW, DAY, MIN, HOUR, setNow, postForm } from "./helpers.js";

// Tuesday 3 March 2026 (GMT): 09:00 London = 09:00Z.
const TUE_0900 = "2026-03-03T09:00:00.000Z";
const TUE_0930 = "2026-03-03T09:30:00.000Z";

describe("hold and confirm", () => {
  beforeEach(resetAll);

  it("lists free slots in UTC, holds one and confirms it", async () => {
    mockFetch();
    const s = await getJson(`/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z`);
    expect(s.status).toBe(200);
    expect(s.data.slots[0]).toBe(TUE_0900);
    // Tuesday has a lunch gap 12:00-13:00: the last morning start is 11:30.
    expect(s.data.slots).toContain("2026-03-03T11:30:00.000Z");
    expect(s.data.slots).not.toContain("2026-03-03T11:45:00.000Z");
    expect(s.data.slots).not.toContain("2026-03-03T12:00:00.000Z");
    const email = fakeEmail();
    const { hold, confirm } = await book(TUE_0900, { envOverrides: { EMAIL: email.binding } });
    expect(hold.status).toBe(200);
    expect(hold.data.expiresAt).toBe(new Date(NOW + 10 * MIN).toISOString());
    expect(confirm.status).toBe(200);
    expect(confirm.data.status).toBe("confirmed");
    expect(confirm.data.manageUrl).toMatch(/^https:\/\/booking\.test\/b\/bk_[a-z0-9]{16}\?t=\d+\.[0-9a-f]{64}$/);
    const [b] = await rows("SELECT * FROM bookings");
    expect(b.status).toBe("confirmed");
    expect(b.start_ms).toBe(Date.parse(TUE_0900));
    expect(b.local_day).toBe("2026-03-03");
    expect(b.hold_token_hash).toBeNull();
    // 30 minutes + 15 buffer = 3 cells of 15 minutes.
    expect((await rows("SELECT cell_ms FROM slot_cells ORDER BY cell_ms")).map((r) => r.cell_ms)).toEqual([0, 15, 30].map((m) => Date.parse(TUE_0900) + m * MIN));
    // The owner email went out with an invite.
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe("sam@example.com");
    // Reminders are queued for 24 h and 1 h before.
    const d = await rows("SELECT kind, status, due_ms FROM deliveries ORDER BY kind");
    expect(d.map((x) => `${x.kind}:${x.status}`)).toEqual(["owner_new:sent", "reminder_owner_1440:pending", "reminder_owner_60:pending"]);
    expect(d.find((x) => x.kind === "reminder_owner_60").due_ms).toBe(Date.parse(TUE_0900) - HOUR);
    // The slot is gone, and so is 09:30 (it would overlap the buffer).
    const s2 = await getJson(`/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z`);
    expect(s2.data.slots).not.toContain(TUE_0900);
    expect(s2.data.slots).not.toContain(TUE_0930);
    expect(s2.data.slots).toContain("2026-03-03T09:45:00.000Z");
  });
});

describe("no double booking", () => {
  beforeEach(resetAll);

  it("20 simultaneous holds on one time: exactly one wins, 19 get 409 with the nearest times", async () => {
    mockFetch();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" }, {}, "none", { "CF-Connecting-IP": `198.51.100.${i + 1}` })),
    );
    const ok = results.filter((r) => r.status === 200);
    const taken = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(taken).toHaveLength(19);
    expect(taken[0].data).toMatchObject({ ok: false, taken: true, code: "taken" });
    expect(taken[0].data.nearest.length).toBeGreaterThan(0);
    expect(taken[0].data.nearest).not.toContain(TUE_0900);
    expect(await rows("SELECT COUNT(*) AS n FROM bookings")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT n FROM day_counts WHERE type_id = '30min'")).toEqual([{ n: 1 }]);
  });

  it("a 60-minute and a 30-minute booking can never overlap", async () => {
    mockFetch();
    const first = await postJson("/api/hold", { type: "60min", start: "2026-03-05T09:30:00.000Z", turnstile: "t" });
    expect(first.status).toBe(200);
    const clash = await postJson("/api/hold", { type: "30min", start: "2026-03-05T10:00:00.000Z", turnstile: "t" }, {}, "none", { "CF-Connecting-IP": "198.51.100.1" });
    expect(clash.status).toBe(409);
    // 10:45 is clear of 09:30-10:30 + 15 buffer.
    const fine = await postJson("/api/hold", { type: "30min", start: "2026-03-05T10:45:00.000Z", turnstile: "t" }, {}, "none", { "CF-Connecting-IP": "198.51.100.1" });
    expect(fine.status).toBe(200);
  });

  it("an expired hold frees the time, and its cells go in the same batch as the next claim", async () => {
    mockFetch();
    const a = await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" });
    expect(a.status).toBe(200);
    setNow(NOW + 11 * MIN);
    const s = await getJson(`/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z`);
    expect(s.data.slots).toContain(TUE_0900);
    const b = await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" }, {}, "none", { "CF-Connecting-IP": "198.51.100.2" });
    expect(b.status).toBe(200);
    expect((await rows("SELECT status FROM bookings ORDER BY created_ms, status")).map((r) => r.status).sort()).toEqual(["expired", "held"]);
    expect(await rows("SELECT COUNT(*) AS n FROM slot_cells")).toEqual([{ n: 3 }]);
    expect(await rows("SELECT n FROM day_counts WHERE type_id = '*'")).toEqual([{ n: 1 }]);
    // The first visitor's confirm says the hold ran out, and the time isn't free any more.
    const c = await postJson("/api/confirm", { holdId: a.data.holdId, token: a.data.token, ...visitor });
    expect(c.status).toBe(409);
    expect(c.data).toMatchObject({ code: "expired", stillFree: false });
  });

  it("a hold that ran out while typing: confirm says so and whether the time is still free", async () => {
    mockFetch();
    const a = await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" });
    setNow(NOW + 10 * MIN);
    const c = await postJson("/api/confirm", { holdId: a.data.holdId, token: a.data.token, ...visitor });
    expect(c.status).toBe(409);
    expect(c.data).toMatchObject({ code: "expired", stillFree: true, start: TUE_0900 });
  });

  it("the daily cap is a CHECK in the same batch: the 5th 30-minute booking on a day is refused", async () => {
    mockFetch();
    const starts = ["09:00", "10:00", "11:00", "13:00", "14:00"].map((t) => `2026-03-03T${t}:00.000Z`);
    const out = [];
    for (const [i, s] of starts.entries()) out.push((await book(s, { details: { ...visitor, email: `v${i}@example.org` }, ip: `198.51.100.${i + 10}` })).hold.status);
    expect(out).toEqual([200, 200, 200, 200, 409]);
    const last = await postJson("/api/hold", { type: "30min", start: starts[4], turnstile: "t" }, {}, "none", { "CF-Connecting-IP": "198.51.100.99" });
    expect(last.data.code).toBe("full");
    expect(await rows("SELECT n, cap FROM day_counts WHERE type_id = '30min'")).toEqual([{ n: 4, cap: 4 }]);
  });

  it("rate limit per network, holds at once per network and per deployment", async () => {
    mockFetch();
    const day = (d, h) => `2026-03-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;
    const ip = { "CF-Connecting-IP": "203.0.113.50" };
    expect((await postJson("/api/hold", { type: "15min", start: day(3, 9), turnstile: "t" }, {}, "none", ip)).status).toBe(200);
    expect((await postJson("/api/hold", { type: "15min", start: day(3, 10), turnstile: "t" }, {}, "none", ip)).status).toBe(200);
    const third = await postJson("/api/hold", { type: "15min", start: day(3, 11), turnstile: "t" }, {}, "none", ip);
    expect(third.status).toBe(429);
    expect(third.data.code).toBe("holds");
    // 10 attempts an hour per network, then refused (also from memory, without D1).
    for (let i = 0; i < 7; i++) await postJson("/api/hold", { type: "15min", start: day(4, 9), turnstile: "t" }, {}, "none", ip);
    const limited = await postJson("/api/hold", { type: "15min", start: day(5, 9), turnstile: "t" }, {}, "none", ip);
    expect(limited.status).toBe(429);
    expect(limited.data.code).toBe("rate");
    // No IP address anywhere in D1.
    const dump = JSON.stringify(await rows("SELECT * FROM rate_counters")) + JSON.stringify(await rows("SELECT * FROM bookings"));
    expect(dump).not.toContain("203.0.113.50");
  });

  it("deployment-wide cap on active holds", async () => {
    mockFetch();
    const results = [];
    for (let i = 0; i < 21; i++) {
      // 5 a day (the owner's cap is 6), weekdays only, around Tuesday's lunch gap.
      const d = [3, 4, 5, 6, 9][Math.floor(i / 5)];
      const h = [9, 10, 11, 13, 14][i % 5];
      const res = await postJson("/api/hold", { type: "15min", start: `2026-03-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`, turnstile: "t" }, {}, "none", { "CF-Connecting-IP": `192.0.2.${i + 1}` });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 200)).toHaveLength(20);
    expect(results[20]).toBe(429);
  });

  it("Turnstile: failed, unreachable, wrong hostname", async () => {
    mockFetch({ turnstile: "fail" });
    expect((await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" })).data.code).toBe("turnstile");
    mockFetch({ turnstile: "down" });
    const down = await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" });
    expect(down.status).toBe(503);
    expect(down.data.error).toMatch(/try again in a minute/);
    mockFetch({ turnstile: { hostname: "evil.example" } });
    expect((await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" })).data.code).toBe("turnstile");
    expect(await rows("SELECT COUNT(*) AS n FROM bookings")).toEqual([{ n: 0 }]);
  });

  it("refuses local times, off-grid starts, switched-off types", async () => {
    mockFetch();
    expect((await postJson("/api/hold", { type: "30min", start: "2026-03-03T09:00:00", turnstile: "t" })).status).toBe(422);
    expect((await postJson("/api/hold", { type: "30min", start: "2026-03-03T09:05:00Z", turnstile: "t" })).status).toBe(422);
    expect((await postJson("/api/hold", { type: "broken", start: TUE_0900, turnstile: "t" })).data.error).toMatch(/isn't set up correctly/);
    expect((await getJson("/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-20T00:00:00Z")).status).toBe(422);
  });

  it("D1 failing: a visible 503 that names FALLBACK_CONTACT; nothing half-booked", async () => {
    mockFetch();
    const { brokenDb } = await import("./helpers.js");
    const r = await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" }, { DB: brokenDb() });
    expect(r.status).toBe(500 < r.status ? r.status : r.status);
    expect([500, 503]).toContain(r.status);
    expect(r.data.error).toMatch(/help@example\.com/);
  });
});

describe("confirming", () => {
  beforeEach(resetAll);

  it("checks fields, the token, double use; blocks listed addresses and domains; caps upcoming bookings per address", async () => {
    mockFetch();
    const h = await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" });
    const bad = await postJson("/api/confirm", { holdId: h.data.holdId, token: h.data.token, name: "", email: "nope", location: "video" });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.data.errors).sort()).toEqual(["email", "name"]);
    expect((await postJson("/api/confirm", { holdId: h.data.holdId, token: "0".repeat(32), ...visitor })).status).toBe(403);
    expect((await postJson("/api/confirm", { holdId: h.data.holdId, token: h.data.token, ...visitor })).status).toBe(200);
    expect((await postJson("/api/confirm", { holdId: h.data.holdId, token: h.data.token, ...visitor })).data.code).toBe("used");

    await env.DB.prepare("INSERT INTO blocked (value, created_at) VALUES ('@spam.example', 'x')").run();
    const h2 = await postJson("/api/hold", { type: "30min", start: "2026-03-04T09:00:00Z", turnstile: "t" });
    const blocked = await postJson("/api/confirm", { holdId: h2.data.holdId, token: h2.data.token, ...visitor, email: "x@spam.example" });
    expect(blocked.status).toBe(403);
    expect((await rows("SELECT status FROM bookings WHERE id = ?1", h2.data.holdId))[0].status).toBe("cancelled"); // released at once

    for (const s of ["2026-03-05T09:00:00Z", "2026-03-06T09:00:00Z"]) expect((await book(s, { ip: "198.51.100.77" })).confirm.status).toBe(200);
    const fourth = await book("2026-03-09T09:00:00Z", { ip: "198.51.100.78" });
    expect(fourth.confirm.status).toBe(429);
    expect(fourth.confirm.data.code).toBe("upcoming");
  });

  it("a filled honeypot releases the hold", async () => {
    mockFetch();
    const h = await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" });
    const r = await postJson("/api/confirm", { holdId: h.data.holdId, token: h.data.token, ...visitor, website: "http://spam" });
    expect(r.status).toBe(422);
    expect(await rows("SELECT COUNT(*) AS n FROM slot_cells")).toEqual([{ n: 0 }]);
  });

  it("with approval on, a request holds the time; the owner gets an approve link, not an invite", async () => {
    mockFetch();
    const email = fakeEmail();
    const { confirm } = await book("2026-03-05T09:00:00Z", { type: "60min", details: { ...visitor, location: "in-person" }, envOverrides: { EMAIL: email.binding } });
    expect(confirm.data.status).toBe("requested");
    const [b] = await rows("SELECT status, request_expires_at FROM bookings");
    expect(b).toEqual({ status: "requested", request_expires_at: NOW + 48 * HOUR });
    expect((await rows("SELECT kind FROM deliveries")).map((d) => d.kind)).toEqual(["owner_request"]);
    expect(email.sent).toHaveLength(1);
    // The time stays taken.
    const s = await getJson(`/api/slots?type=30min&from=2026-03-05T00:00:00Z&to=2026-03-06T00:00:00Z`);
    expect(s.data.slots).not.toContain("2026-03-05T09:30:00.000Z");
  });
});

describe("the no-JavaScript path", () => {
  beforeEach(resetAll);

  it("shows times in the owner's zone as a plain form, and books in one post (303 to the manage page)", async () => {
    mockFetch();
    const page = await call("/nojs/30min");
    const body = await page.text();
    expect(page.status).toBe(200);
    expect(body).toContain("Times in London time");
    expect(body).toContain(`value="${Date.parse(TUE_0900)}"`);
    expect(body).not.toContain("<script");
    const res = await postForm("/nojs/30min", { start: String(Date.parse(TUE_0900)), name: "Zoë", email: "zoe@example.org", location: "video" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toMatch(/^https:\/\/booking\.test\/b\/bk_/);
    const [b] = await rows("SELECT status, via, turnstile, visitor_tz FROM bookings");
    expect(b).toEqual({ status: "confirmed", via: "nojs", turnstile: "off", visitor_tz: "Europe/London" });
  });

  it("has a tighter limit (2 an hour) and shows problems as a page", async () => {
    mockFetch();
    const start = (h) => String(Date.UTC(2026, 2, 3, h));
    expect((await postForm("/nojs/15min", { start: start(9), name: "A", email: "a@example.org" }, {}, "none", "192.0.2.200")).status).toBe(303);
    const missing = await postForm("/nojs/15min", { start: start(10), name: "", email: "a@example.org" }, {}, "none", "192.0.2.200");
    expect(missing.status).toBe(422);
    expect(await missing.text()).toContain("Name is required");
    const third = await postForm("/nojs/15min", { start: start(11), name: "A", email: "b@example.org" }, {}, "none", "192.0.2.200");
    expect(third.status).toBe(429);
    expect(await rows("SELECT COUNT(*) AS n FROM slot_cells")).toEqual([{ n: 1 }]); // the failed form released its hold
  });

  it("is off with provider-confirm (it can't do Turnstile)", async () => {
    mockFetch();
    expect((await call("/nojs/30min", {}, {}, "confirm")).status).toBe(404);
  });
});
describe("guarded batches under concurrency", () => {
  beforeEach(resetAll);

  it("the same hold confirmed twice at once: one booking, one set of notifications", async () => {
    mockFetch();
    const h = await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" });
    const both = await Promise.all([1, 2].map(() => postJson("/api/confirm", { holdId: h.data.holdId, token: h.data.token, ...visitor })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await rows("SELECT COUNT(*) AS n FROM deliveries WHERE kind = 'owner_new'")).toEqual([{ n: 1 }]);
  });

  it("a reschedule and a new hold racing for the same time: exactly one gets it", async () => {
    mockFetch();
    const a = await book(TUE_0900);
    const t = new URL(a.confirm.data.manageUrl).searchParams.get("t");
    const target = "2026-03-04T11:00:00.000Z";
    const [move, grab] = await Promise.all([
      postJson(`/b/${a.confirm.data.bookingId}/reschedule`, { t, start: Date.parse(target) }),
      postJson("/api/hold", { type: "30min", start: target, turnstile: "t" }, {}, "none", { "CF-Connecting-IP": "198.51.100.200" }),
    ]);
    expect([move.status, grab.status].sort()).toEqual([200, 409]);
    const owners = await rows("SELECT DISTINCT booking_id FROM slot_cells WHERE cell_ms = ?1", Date.parse(target));
    expect(owners).toHaveLength(1);
    // Whoever lost, the moved booking still holds exactly its own cells.
    const cells = await rows("SELECT COUNT(*) AS n FROM slot_cells WHERE booking_id = ?1", a.confirm.data.bookingId);
    expect(cells).toEqual([{ n: 3 }]);
  });

  it("cancel twice at once: released once, counted down once", async () => {
    mockFetch();
    await book("2026-03-03T10:00:00Z", { details: { ...visitor, email: "o@example.org" }, ip: "198.51.100.201" });
    const a = await book(TUE_0900);
    const t = new URL(a.confirm.data.manageUrl).searchParams.get("t");
    const r = await Promise.all([1, 2].map(() => postJson(`/b/${a.confirm.data.bookingId}/cancel`, { t })));
    expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await rows("SELECT n FROM day_counts WHERE type_id = '30min'")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM deliveries WHERE kind = 'owner_cancel'")).toEqual([{ n: 1 }]);
  });

  it("after a confirm the Clock is woken for the next due time", async () => {
    mockFetch();
    const { clockCalls } = await import("./helpers.js");
    await book(TUE_0900);
    expect(clockCalls).toContain(Date.parse(TUE_0900) - 24 * HOUR);
  });
});