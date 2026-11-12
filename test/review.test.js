// Fixes from the first review: each test names the item.
import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { resetAll, mockFetch, postJson, getJson, call, book, rows, fakeEmail, visitor, NOW, MIN, HOUR, DAY, setNow, api, appFor, ics, refreshCalls, postForm } from "./helpers.js";
import { refreshAll, readBusy } from "../src/lib/busy.js";
import { parseIcs } from "../src/lib/ics-parse.js";
import { runHousekeeping } from "../src/lib/housekeeping.js";
import { bookingIcs } from "../src/lib/notify.js";
import { readBody } from "../src/lib/http.js";
import { TEST_CONFIG, PROVIDER_CONFIG } from "./config.js";

const URL1 = "https://cal.test/private.ics";
const TUE_0900 = "2026-03-03T09:00:00.000Z";

describe("review fixes", () => {
  beforeEach(resetAll);

  it("H1: a 304 keeps the copy, but a full re-read happens after 12 hours so the horizon keeps moving", async () => {
    const late = NOW + 62 * DAY + 6 * HOUR; // just past the first parse's horizon (60 days + 2)
    const feed = ics(["UID:far", `DTSTART:${new Date(late).toISOString().replace(/[-:]|\.\d{3}/g, "")}`, "DURATION:PT1H"]);
    const seen = [];
    mockFetch({ feeds: { [URL1]: (init) => (seen.push(init.headers?.["If-None-Match"] ?? null), init.headers?.["If-None-Match"] ? { status: 304 } : { body: feed, headers: { ETag: '"v1"' } }) } });
    const at = async (t) => {
      setNow(t);
      const app = appFor({ CALENDAR_ICS_URLS: URL1 });
      await refreshAll(app, t);
      return (await readBusy(app, t)).intervals;
    };
    expect(await at(NOW)).toEqual([]);
    expect(await at(NOW + 11 * HOUR)).toEqual([]); // 304
    const after = await at(NOW + 13 * HOUR); // full parse, no If-None-Match
    expect(seen).toEqual([null, '"v1"', null]);
    expect(after).toEqual([[late / MIN, late / MIN + 60]]);
  });

  it("H2: visitor requests never fetch or parse; they ask the Clock (and pause with no Clock and no copy)", async () => {
    const calls = mockFetch({ feeds: { [URL1]: ics(["UID:a", "DTSTART:20260303T100000Z", "DURATION:PT1H"]) } });
    const s = await getJson("/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z", { CALENDAR_ICS_URLS: URL1 });
    expect(refreshCalls).toHaveLength(1); // the fetch happened inside the Clock's refreshCalendar
    expect(s.data.slots).not.toContain("2026-03-03T10:00:00.000Z");
    await env.DB.prepare("DELETE FROM busy_cache").run();
    const before = calls.length;
    const p = await getJson("/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z", { CALENDAR_ICS_URLS: URL1, CLOCK: undefined });
    expect(p.data).toMatchObject({ paused: true, slots: [] });
    expect(calls.length).toBe(before); // nothing fetched in the Worker
  });

  it("H2: the real Clock has refreshCalendar (no links: nothing to do)", async () => {
    const stub = env.CLOCK.get(env.CLOCK.idFromName("clock"));
    const r = await runInDurableObject(stub, (inst) => inst.refreshCalendar("https://booking.test"));
    expect(r).toMatchObject({ links: 0 });
  });

  it("M3: impossible dates and a TZID of 'constructor' don't throw", () => {
    const now = Date.UTC(2026, 2, 1);
    const text = ics(
      ["UID:a", "DTSTART;VALUE=DATE:20270230"],
      ["UID:b", "DTSTART;TZID=constructor:20260305T100000", "DURATION:PT1H"],
      ["UID:c", "DTSTART:20260305T250000Z", "DURATION:PT1H"],
      ["UID:d", "DTSTART:20260306T090000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=2", "EXDATE:20260399T090000Z"],
    );
    const r = parseIcs(text, { ownerZone: "Europe/London", now, until: now + 30 * DAY });
    expect(r.stats.unknownZones).toEqual(["constructor"]);
    expect(r.intervals.length).toBe(3); // b (owner's zone), d twice
  });

  it("M4: a CALENDAR_ICS_URLS entry that can't be used pauses bookings and is reported", async () => {
    mockFetch({ feeds: { [URL1]: ics(["UID:a", "DTSTART:20260303T100000Z", "DURATION:PT1H"]) } });
    const e = { CALENDAR_ICS_URLS: `${URL1}, http://cal.example.com/x.ics` };
    expect((await getJson("/api/slots?type=30min&from=2026-03-03T00:00:00Z&to=2026-03-04T00:00:00Z", e)).data.paused).toBe(true);
    const check = await api("GET", "calendar-check", undefined, e);
    expect(check.data.problems[0]).toMatch(/1 entry that isn't an https/);
    expect((await api("GET", "config", undefined, e)).data.calendar.problems.length).toBeGreaterThan(0);
  });

  it("M6: holiday feeds block their days even though holidays are marked free (TRANSPARENT)", async () => {
    const H = "https://holidays.test/uk.ics";
    mockFetch({ feeds: { [H]: ics(["UID:h1", "DTSTART;VALUE=DATE:20260304", "DTEND;VALUE=DATE:20260305", "TRANSP:TRANSPARENT", "SUMMARY:Holiday"]) } });
    const cfg = { ...TEST_CONFIG, owner: { ...TEST_CONFIG.owner, holidayFeeds: [H] } };
    const app = appFor({}, cfg);
    await refreshAll(app, NOW);
    const busy = await readBusy(app, NOW);
    expect(busy.intervals).toEqual([[Date.UTC(2026, 2, 4) / MIN, Date.UTC(2026, 2, 5) / MIN]]);
  });

  it("M7: an expired request from a no-JS (no Turnstile) booking queues no visitor email", async () => {
    mockFetch();
    const r = await postForm("/nojs/60min", { start: String(Date.UTC(2026, 2, 5, 9)), name: "N", email: "n@example.org", location: "in-person" }, {}, "provider");
    expect(r.status).toBe(303);
    const t = NOW + 49 * HOUR;
    await runHousekeeping(appFor({ EMAIL: fakeEmail().binding }, PROVIDER_CONFIG), { now: t, force: true });
    expect((await rows("SELECT kind FROM deliveries ORDER BY kind")).map((d) => d.kind)).toEqual(["owner_expired", "owner_request"]);
  });

  it("M8: at most 3 reschedules a day per booking", async () => {
    mockFetch();
    const a = await book(TUE_0900);
    const t = new URL(a.confirm.data.manageUrl).searchParams.get("t");
    const id = a.confirm.data.bookingId;
    const starts = ["2026-03-03T10:00:00Z", "2026-03-03T11:00:00Z", "2026-03-03T13:00:00Z", "2026-03-03T14:00:00Z"];
    const out = [];
    for (const s of starts) out.push((await postJson(`/b/${id}/reschedule`, { t, start: Date.parse(s) })).status);
    expect(out).toEqual([200, 200, 200, 429]);
  });

  it("M9: the UID host is fixed when booked; an invite built later on another host keeps it", async () => {
    mockFetch();
    const a = await book(TUE_0900);
    const [b] = await rows("SELECT * FROM bookings");
    expect(b.uid_host).toBe("booking.test");
    const other = { ...appFor(), host: "other.example" };
    expect(bookingIcs(other, b, { method: "CANCEL", forVisitor: false })).toContain(`UID:${a.confirm.data.bookingId}@booking.test`);
  });

  it("M9: the Clock keeps the first origin it's given", async () => {
    const stub = env.CLOCK.get(env.CLOCK.idFromName("clock"));
    await runInDurableObject(stub, async (inst, state) => {
      await state.storage.delete("origin");
      inst.origin = null;
      await inst.rememberOrigin("https://first.example");
      await inst.rememberOrigin("https://second.example");
      expect(await state.storage.get("origin")).toBe("https://first.example");
    });
  });

  it("LOW: admin ignoreRules still needs the grid; verify after start is refused; bodies are capped without Content-Length; an over-cap feed pauses at once", async () => {
    mockFetch({ feeds: { [URL1]: { body: `BEGIN:VCALENDAR\r\n${"X".repeat(20 * 1024)}` } } });
    expect((await api("POST", "bookings", { type: "30min", start: "2026-03-07T09:05:00Z", name: "G", email: "g@example.org", location: "video", ignoreRules: true })).status).toBe(422);
    const big = new Request("https://x/", { method: "POST", headers: { "Content-Type": "application/json" }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`{"a":"${"x".repeat(40000)}"}`)); c.close(); } }), duplex: "half" });
    expect(await readBody(big, 1024)).toBeNull();
    const app = appFor({ CALENDAR_ICS_URLS: URL1, FEED_MAX_KB: "16" });
    const { sources } = await import("../src/lib/busy.js");
    const key = (await sources(app)).list[0].key;
    // A good copy from an hour ago doesn't keep bookings open once the feed is over the cap.
    await env.DB.prepare("INSERT INTO busy_cache (source, kind, ok_at, fetched_at, intervals) VALUES (?1, 'calendar', ?2, 0, '[]')").bind(key, NOW - HOUR).run();
    await refreshAll(app, NOW);
    expect((await readBusy(app, NOW)).paused).toBe(true);
  });

  it("LOW: confirm-your-email can't confirm a booking whose start has passed", async () => {
    const { verifyEmail } = await import("../src/lib/bookings.js");
    mockFetch();
    const h = await postJson("/api/hold", { type: "30min", start: TUE_0900, turnstile: "t" });
    await env.DB.prepare("UPDATE bookings SET verify_pending = 1, hold_expires_at = ?2 WHERE id = ?1").bind(h.data.holdId, Date.parse(TUE_0900) + DAY).run();
    const [b] = await rows("SELECT * FROM bookings");
    const r = await verifyEmail(appFor(), b, appFor().cfg.types.get("30min"), Date.parse(TUE_0900) + MIN);
    expect(r.ok).toBe(false);
  });
});
