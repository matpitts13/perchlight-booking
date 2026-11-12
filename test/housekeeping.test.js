import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { resetAll, mockFetch, postJson, getJson, call, book, rows, fakeEmail, visitor, NOW, MIN, HOUR, DAY, setNow, api, appFor, clockCalls, ics, TOKEN } from "./helpers.js";
import { runHousekeeping, nextDue } from "../src/lib/housekeeping.js";

const TUE_0900 = "2026-03-03T09:00:00.000Z";
const START = Date.parse(TUE_0900);

function clockStub() {
  return env.CLOCK.get(env.CLOCK.idFromName("clock"));
}

describe("the Clock (Durable Object alarm, no cron)", () => {
  beforeEach(resetAll);
  afterEach(async () => {
    await runInDurableObject(clockStub(), (_, state) => state.storage.deleteAlarm());
  });

  it("wake() keeps whichever alarm is earlier, and costs no write when it's later", async () => {
    const base = Date.now() + HOUR;
    const stub = clockStub();
    expect(await stub.wake(base + 2 * HOUR, "https://booking.test")).toBe(base + 2 * HOUR);
    expect(await stub.wake(base, "https://booking.test")).toBe(base);
    expect(await stub.wake(base + 5 * HOUR)).toBe(base); // later: unchanged
    expect(await stub.getNext()).toBe(base);
  });

  it("an alarm run sends a due reminder once, even when it runs twice, and sets the next alarm", async () => {
    mockFetch();
    await book(TUE_0900);
    const due = START - HOUR + MIN;
    const stub = clockStub();
    const next1 = await runInDurableObject(stub, (inst) => inst.tick(due, () => due));
    const next2 = await runInDurableObject(stub, (inst) => inst.tick(due, () => due));
    const r = await rows("SELECT kind, status, attempts FROM deliveries WHERE kind = 'reminder_owner_60'");
    expect(r).toEqual([{ kind: "reminder_owner_60", status: "sent", attempts: 1 }]);
    expect(next1).toBeNull(); // nothing else due
    expect(next2).toBeNull();
  });

  it("an alarm run expires a hold nobody confirmed", async () => {
    mockFetch();
    const h = await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" });
    expect(clockCalls).toEqual([NOW + 10 * MIN]); // woken for the hold's expiry
    const at = NOW + 10 * MIN;
    await runInDurableObject(clockStub(), (inst) => inst.tick(at, () => at));
    expect((await rows("SELECT status FROM bookings WHERE id = ?1", h.data.holdId))[0].status).toBe("expired");
    expect(await rows("SELECT COUNT(*) AS n FROM slot_cells")).toEqual([{ n: 0 }]);
  });

  it("idle: no visitors and no bookings means no Clock calls and no alarm", async () => {
    mockFetch();
    await call("/api/types");
    await call("/tick");
    expect(clockCalls).toEqual([]);
    expect(await nextDue(env)).toBeNull();
  });
});

describe("lazy housekeeping (the fallback)", () => {
  beforeEach(resetAll);

  it("with the Clock unavailable, reminders go out on the next request, never after the meeting started", async () => {
    mockFetch();
    const email = fakeEmail();
    const noClock = { CLOCK: undefined, EMAIL: email.binding };
    await book(TUE_0900, { envOverrides: noClock });
    expect(email.sent).toHaveLength(1); // owner_new
    setNow(START - 24 * HOUR + MIN);
    await call("/tick", {}, noClock);
    expect(email.sent).toHaveLength(2);
    expect((await rows("SELECT status FROM deliveries WHERE kind = 'reminder_owner_1440'"))[0].status).toBe("sent");
    // Nobody visits until after the start: the 1-hour reminder is dropped, not sent late.
    setNow(START + MIN);
    await call("/tick", {}, noClock);
    expect(email.sent).toHaveLength(2);
    expect((await rows("SELECT status, last_error FROM deliveries WHERE kind = 'reminder_owner_60'"))[0]).toEqual({ status: "skipped", last_error: "the meeting had already started" });
  });

  it("is throttled by the state row: two requests a moment apart run it once", async () => {
    mockFetch();
    const app = appFor();
    expect((await runHousekeeping(app, { now: NOW })).ran).toBe(true);
    expect((await runHousekeeping(appFor(), { now: NOW + MIN })).ran).toBe(false);
    expect((await runHousekeeping(appFor(), { now: NOW + 6 * MIN })).ran).toBe(true);
  });

  it("a failed send is retried after 1 minute, with the Clock woken for it", async () => {
    mockFetch();
    const bad = fakeEmail({ fail: "network error" });
    await book(TUE_0900, { envOverrides: { EMAIL: bad.binding } });
    const [d] = await rows("SELECT status, next_attempt_at, last_error FROM deliveries WHERE kind = 'owner_new'");
    expect(d).toEqual({ status: "retry", next_attempt_at: NOW + MIN, last_error: "send_email: network error" });
    expect(clockCalls).toContain(NOW + MIN);
    const good = fakeEmail();
    await runHousekeeping(appFor({ EMAIL: good.binding }), { now: NOW + MIN, force: true });
    expect(good.sent).toHaveLength(1);
    expect((await rows("SELECT status FROM deliveries WHERE kind = 'owner_new'"))[0].status).toBe("sent");
  });

  it("a reminder whose retries would run past the start is skipped, not sent late", async () => {
    mockFetch();
    await book(TUE_0900, { envOverrides: { EMAIL: fakeEmail().binding } });
    const at = START - 3 * MIN; // 1-hour reminder retried this late
    await env.DB.prepare("UPDATE deliveries SET next_attempt_at = ?1, attempts = 4 WHERE kind = 'reminder_owner_60'").bind(at).run();
    await runHousekeeping(appFor({ EMAIL: fakeEmail({ fail: "down" }).binding }), { now: at, force: true });
    const [d] = await rows("SELECT status, last_error FROM deliveries WHERE kind = 'reminder_owner_60'");
    expect(d.status).toBe("skipped");
    expect(d.last_error).toMatch(/not sent before the meeting started/);
  });
});

describe("the Perchlight desktop app's buttons", () => {
  beforeEach(resetAll);

  it("cancel_requested / approve_requested / decline_requested are carried out by housekeeping", async () => {
    mockFetch();
    const a = await book(TUE_0900);
    const r1 = await book("2026-03-05T09:00:00Z", { type: "60min", details: { ...visitor, location: "in-person", email: "r1@example.org" }, ip: "198.51.100.61" });
    const r2 = await book("2026-03-06T09:00:00Z", { type: "60min", details: { ...visitor, location: "in-person", email: "r2@example.org" }, ip: "198.51.100.62" });
    await env.DB.batch([
      env.DB.prepare("UPDATE bookings SET status = 'cancel_requested' WHERE id = ?1").bind(a.confirm.data.bookingId),
      env.DB.prepare("UPDATE bookings SET status = 'approve_requested' WHERE id = ?1").bind(r1.confirm.data.bookingId),
      env.DB.prepare("UPDATE bookings SET status = 'decline_requested' WHERE id = ?1").bind(r2.confirm.data.bookingId),
    ]);
    await runHousekeeping(appFor({ EMAIL: fakeEmail().binding }), { now: NOW + MIN, force: true });
    const s = Object.fromEntries((await rows("SELECT id, status, cancelled_by FROM bookings")).map((b) => [b.id, `${b.status}/${b.cancelled_by}`]));
    expect(s[a.confirm.data.bookingId]).toBe("cancelled/owner");
    expect(s[r1.confirm.data.bookingId]).toBe("confirmed/null");
    expect(s[r2.confirm.data.bookingId]).toBe("declined/owner");
    expect((await rows("SELECT DISTINCT booking_id FROM slot_cells")).map((r) => r.booking_id)).toEqual([r1.confirm.data.bookingId]);
  });

  it("a cancel_requested on a booking already released doesn't release anything twice", async () => {
    mockFetch();
    const a = await book(TUE_0900);
    const id = a.confirm.data.bookingId;
    await postJson(`/b/${id}/cancel`, { t: new URL(a.confirm.data.manageUrl).searchParams.get("t") });
    const other = await book(TUE_0900, { details: { ...visitor, email: "c@example.org" }, ip: "198.51.100.63" }); // takes the same time
    expect(other.confirm.status).toBe(200);
    await env.DB.prepare("UPDATE bookings SET status = 'cancel_requested' WHERE id = ?1").bind(id).run();
    await runHousekeeping(appFor({ EMAIL: fakeEmail().binding }), { now: NOW + MIN, force: true });
    expect((await rows("SELECT status FROM bookings WHERE id = ?1", id))[0].status).toBe("cancelled");
    expect(await rows("SELECT n FROM day_counts WHERE type_id = '30min'")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM slot_cells WHERE booking_id = ?1", other.confirm.data.bookingId)).toEqual([{ n: 3 }]);
  });
});

describe("retention and erasure", () => {
  beforeEach(resetAll);

  it("personal details are removed 90 days after the meeting; the row stays as an anonymous record", async () => {
    mockFetch();
    await book(TUE_0900, { details: { ...visitor, phone: "+44 20 7946 0000", notes: "hello" } });
    const later = START + 91 * DAY;
    await runHousekeeping(appFor(), { now: later, force: true });
    const [b] = await rows("SELECT name, email, phone, notes, visitor_tz, anonymised_at, status, type_id FROM bookings");
    expect(b).toMatchObject({ name: null, email: null, phone: null, notes: null, visitor_tz: null, status: "confirmed", type_id: "30min" });
    expect(b.anonymised_at).not.toBeNull();
    expect(await rows("SELECT COUNT(*) AS n FROM deliveries")).toEqual([{ n: 0 }]);
  });

  it("export, then erase everything for one address: upcoming ones cancelled, you get the list", async () => {
    mockFetch();
    const email = fakeEmail();
    await book(TUE_0900, { details: { ...visitor, name: "=HYPERLINK(\"x\")" } });
    const res = await call("/api/export?email=ada@example.org&format=csv", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM: Excel keeps accents
    expect(new TextDecoder().decode(bytes)).toContain("'=HYPERLINK");
    const r = await api("DELETE", "bookings?email=ada@example.org", undefined, { EMAIL: email.binding });
    expect(r.data).toMatchObject({ ok: true, erased: 1, more: false, ownerEmail: "sent" });
    expect(r.data.cancelledUpcoming).toHaveLength(1);
    expect(await rows("SELECT status, email, name FROM bookings")).toEqual([{ status: "cancelled", email: null, name: null }]);
    expect(await rows("SELECT COUNT(*) AS n FROM slot_cells")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM deliveries")).toEqual([{ n: 0 }]);
    expect(email.sent).toHaveLength(1);
    expect((await api("GET", "export?email=ada@example.org")).data.bookings).toEqual([]);
  });

  it("no IP address appears in any table", async () => {
    mockFetch();
    await book(TUE_0900, { ip: "203.0.113.123" });
    await call("/nojs/30min", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "2001:db8::1234" }, body: `start=${START + HOUR}&name=X&email=x%40example.org&location=video` });
    const tables = ["bookings", "slot_cells", "day_counts", "deliveries", "rate_counters", "daily_counts", "email_counts", "state", "busy_cache"];
    for (const t of tables) {
      const dump = JSON.stringify(await rows(`SELECT * FROM ${t}`));
      expect(dump).not.toContain("203.0.113.123");
      expect(dump).not.toContain("2001:db8");
    }
  });
});

describe("the admin API", () => {
  beforeEach(resetAll);

  it("needs the token (constant-time compare, 16+ characters)", async () => {
    expect((await call("/api/bookings")).status).toBe(401);
    expect((await api("GET", "bookings", undefined, {}, "wrong-token-0123456789")).status).toBe(401);
    expect((await api("GET", "bookings", undefined, { ADMIN_TOKEN: "short" }, "short")).status).toBe(503);
    expect((await api("GET", "bookings")).status).toBe(200);
  });

  it("days off from the API apply without a redeploy; config lists bookings now outside your hours", async () => {
    mockFetch();
    await book(TUE_0900);
    expect((await api("POST", "exceptions", { date: "2026-03-03", kind: "off", note: "dentist" })).status).toBe(200);
    expect((await getJson("/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z")).data.slots).toEqual([]);
    const cfg = await api("GET", "config");
    expect(cfg.data.outsideAvailability).toHaveLength(1);
    expect(cfg.data.types.find((t) => t.id === "broken")).toMatchObject({ on: false });
    expect((await api("POST", "exceptions", { date: "2026-03-04", kind: "hours", ranges: [["10:00", "11:00"]] })).status).toBe(200);
    expect((await getJson("/api/slots?type=30min&from=2026-03-04T00:00:00Z&to=2026-03-05T00:00:00Z")).data.slots).toEqual(["2026-03-04T10:00:00.000Z", "2026-03-04T10:15:00.000Z", "2026-03-04T10:30:00.000Z"]);
    expect((await api("DELETE", "exceptions?date=2026-03-03")).data.deleted).toBe(1);
  });

  it("book on someone's behalf; set a video link (sequence + 1, update sent); cancel and block", async () => {
    mockFetch();
    const made = await api("POST", "bookings", { type: "30min", start: TUE_0900, name: "Grace", email: "grace@example.org", location: "video" });
    expect(made.status).toBe(200);
    const id = made.data.booking.id;
    const loc = await api("PATCH", `bookings/${id}`, { action: "location", link: "https://meet.example.com/room2" });
    expect(loc.data.booking).toMatchObject({ sequence: 1, location_detail: "https://meet.example.com/room2" });
    expect((await rows("SELECT kind FROM deliveries WHERE kind = 'owner_change'"))).toHaveLength(1);
    const c = await api("PATCH", `bookings/${id}`, { action: "cancel", reason: "spam", block: true });
    expect(c.data.booking.status).toBe("cancelled");
    expect(await rows("SELECT value FROM blocked")).toEqual([{ value: "grace@example.org" }]);
    const one = await api("GET", `bookings/${id}`);
    expect(one.data.booking.hold_token_hash).toBeUndefined();
    expect(one.data.deliveries.length).toBeGreaterThan(0);
  });

  it("lists bookings with a cursor", async () => {
    mockFetch();
    for (const [i, s] of ["2026-03-03T09:00:00Z", "2026-03-04T09:00:00Z", "2026-03-05T09:00:00Z"].entries()) {
      await book(s, { details: { ...visitor, email: `p${i}@example.org` }, ip: `198.51.100.${70 + i}` });
    }
    const p1 = await api("GET", "bookings?limit=2");
    expect(p1.data.bookings).toHaveLength(2);
    const p2 = await api("GET", `bookings?limit=2&cursor=${p1.data.cursor}`);
    expect(p2.data.bookings).toHaveLength(1);
    expect(p2.data.cursor).toBeNull();
  });
});

describe("your calendar's busy times", () => {
  beforeEach(resetAll);
  const URL1 = "https://cal.test/private.ics";
  const feed = ics(["UID:e1@google.com", "DTSTART:20260303T100000Z", "DTEND:20260303T110000Z"], ["UID:e2", "DTSTART:20260304T090000Z", "DURATION:PT30M", "RRULE:FREQ=HOURLY"]);

  it("busy times are never offered; the feed is cached, re-read with If-None-Match, and checked before a hold", async () => {
    let n = 0;
    const calls = mockFetch({ feeds: { [URL1]: (init) => (n++ && init.headers?.["If-None-Match"] === '"v1"' ? { status: 304 } : { body: feed, headers: { ETag: '"v1"' } }) } });
    const e = { CALENDAR_ICS_URLS: URL1 };
    const s = await getJson("/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z", e);
    expect(s.data.slots).not.toContain("2026-03-03T10:00:00.000Z");
    expect(s.data.slots).not.toContain("2026-03-03T09:30:00.000Z"); // ends 10:00 + 15 buffer before the busy time
    expect(s.data.slots).toContain("2026-03-03T09:15:00.000Z");
    expect(s.data.slots).not.toContain("2026-03-03T10:45:00.000Z"); // 15-minute buffer after the busy time
    const feedCalls = () => calls.filter((c) => c.url === URL1).length;
    expect(feedCalls()).toBe(1);
    await getJson("/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z", e);
    expect(feedCalls()).toBe(1); // cached
    setNow(NOW + 11 * MIN);
    await getJson("/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z", e);
    expect(feedCalls()).toBe(2); // refreshed after the reply, 304
    expect((await rows("SELECT ok_at FROM busy_cache"))[0].ok_at).toBe(NOW + 11 * MIN);
    // A busy time is refused at hold time too.
    const h = await postJson("/api/hold", { type: "30min", start: "2026-03-03T10:00:00Z", turnstile: "t" }, e);
    expect(h.status).toBe(409);
    // The unsupported hourly rule over-blocks and is reported.
    const check = await api("GET", "calendar-check", undefined, e);
    expect(check.data.results[0].unsupportedRules[0]).toMatchObject({ rule: "FREQ=HOURLY", treatedAs: "busy every day at that time" });
    expect(JSON.stringify(check.data)).not.toContain("cal.test"); // the link is a secret
  });

  it("feed down: the last good copy is used for 24 hours, then bookings pause (and you're told once)", async () => {
    let down = false;
    mockFetch({ feeds: { [URL1]: () => (down ? "down" : feed) } });
    const e = { CALENDAR_ICS_URLS: URL1, EMAIL: fakeEmail().binding };
    expect((await getJson("/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z", e)).data.paused).toBeUndefined();
    down = true;
    setNow(NOW + 2 * HOUR);
    const mid = await postJson("/api/hold", { type: "30min", start: "2026-03-03T13:00:00Z", turnstile: "t" }, e);
    expect(mid.status).toBe(200); // last copy is 2 hours old: still used
    setNow(NOW + 25 * HOUR);
    const s = await getJson("/api/slots?type=30min&from=2026-03-04T00:00:00Z&to=2026-03-05T00:00:00Z", e);
    expect(s.data).toMatchObject({ paused: true, slots: [] });
    const h = await postJson("/api/hold", { type: "30min", start: "2026-03-05T13:00:00Z", turnstile: "t" }, { ...e, CF: 1 }, "none", { "CF-Connecting-IP": "198.51.100.88" });
    expect(h.status).toBe(503);
    expect(h.data.error).toMatch(/paused while the calendar can't be read/);
    const notices = await rows("SELECT kind FROM deliveries WHERE booking_id = ''");
    expect(notices).toEqual([{ kind: "owner_paused" }]);
  });

  it("no calendar link set: only bookings made here block time", async () => {
    mockFetch();
    expect((await getJson("/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z")).data.slots.length).toBeGreaterThan(10);
    expect((await api("GET", "calendar-check")).data.links).toBe(0);
  });
});

export { TOKEN };
