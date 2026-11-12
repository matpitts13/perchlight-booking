import { describe, it, expect } from "vitest";
import { wallToUtc, localDate, offsetMs, formatWhen, isZone } from "../src/lib/tz.js";
import { checkConfig, intersectRanges } from "../src/lib/config.js";
import { freeSlots, dayStarts, ruleProblem, cellsFor, nearest } from "../src/lib/slots.js";
import { checkDetails, isEmail, oneLine } from "../src/lib/validate.js";
import { vevent, calendar, fold, icsText } from "../src/lib/ics-write.js";
import { mime, encodeHeader, headerSafe } from "../src/lib/mime.js";
import { signToken, verifyToken } from "../src/lib/links.js";
import { rateKey, networkOf } from "../src/lib/ratelimit.js";
import { safeName, buildEmail } from "../src/lib/notify.js";
import { escapeHtml } from "../src/lib/http.js";
import { deliveryPlan } from "../src/lib/bookings.js";
import { csvCell } from "../src/routes/admin.js";
import { TEST_CONFIG } from "./config.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const cfg = checkConfig(TEST_CONFIG);
const t30 = cfg.types.get("30min");
const empty = { exceptions: new Map(), busy: [], cells: new Set(), counts: new Map() };

function withConfig(patch) {
  return checkConfig({ ...TEST_CONFIG, ...patch, owner: { ...TEST_CONFIG.owner, ...(patch.owner ?? {}) } });
}

describe("time zones", () => {
  it("London spring forward: 01:30 doesn't exist and moves to 02:00 BST (01:00Z)", () => {
    expect(iso(wallToUtc("Europe/London", 2026, 3, 29, 1, 30))).toBe("2026-03-29T01:00:00.000Z");
    expect(iso(wallToUtc("Europe/London", 2026, 3, 29, 3, 0))).toBe("2026-03-29T02:00:00.000Z");
  });
  it("London fall back: 01:30 happens twice; earlier by default, later on request", () => {
    expect(iso(wallToUtc("Europe/London", 2026, 10, 25, 1, 30))).toBe("2026-10-25T00:30:00.000Z");
    expect(iso(wallToUtc("Europe/London", 2026, 10, 25, 1, 30, 0, "later"))).toBe("2026-10-25T01:30:00.000Z");
  });
  it("New York, Kolkata (no DST), Kathmandu (+05:45), Lord Howe (30-minute DST), Apia", () => {
    expect(iso(wallToUtc("America/New_York", 2026, 3, 8, 2, 30))).toBe("2026-03-08T07:00:00.000Z"); // gap -> 03:00 EDT
    expect(iso(wallToUtc("America/New_York", 2026, 11, 1, 1, 30))).toBe("2026-11-01T05:30:00.000Z"); // first 01:30 (EDT)
    expect(iso(wallToUtc("Asia/Kolkata", 2026, 6, 1, 9, 0))).toBe("2026-06-01T03:30:00.000Z");
    expect(iso(wallToUtc("Asia/Kathmandu", 2026, 6, 1, 9, 0))).toBe("2026-06-01T03:15:00.000Z");
    // Lord Howe: +11 in summer, +10:30 in winter; DST ends 5 April 2026 at 02:00 -> 01:30.
    expect(offsetMs("Australia/Lord_Howe", Date.UTC(2026, 0, 10)) / MIN).toBe(660);
    expect(offsetMs("Australia/Lord_Howe", Date.UTC(2026, 6, 10)) / MIN).toBe(630);
    expect(iso(wallToUtc("Australia/Lord_Howe", 2026, 4, 5, 1, 45))).toBe("2026-04-04T14:45:00.000Z"); // earlier (+11)
    expect(iso(wallToUtc("Australia/Lord_Howe", 2026, 4, 5, 1, 45, 0, "later"))).toBe("2026-04-04T15:15:00.000Z");
    expect(offsetMs("Pacific/Apia", Date.UTC(2026, 6, 1)) / HOUR).toBe(13);
    expect(isZone("Mars/Olympus")).toBe(false);
  });
  it("formats times with their offset", () => {
    expect(formatWhen(Date.UTC(2026, 2, 3, 9), "America/New_York")).toMatch(/04:00.*GMT-5/);
  });
});

describe("config", () => {
  it("switches off only the broken type and names the mistake", () => {
    expect(cfg.types.get("30min").on).toBe(true);
    expect(cfg.types.get("broken").on).toBe(false);
    expect(cfg.errors.join(" ")).toMatch(/types\.broken: minutes must be a multiple of 15/);
  });
  it("owner mistakes switch every type off; reserved slugs, bad zones and ranges are reported", () => {
    const c = withConfig({ owner: { timeZone: "Nowhere/Here" }, types: { api: { name: "x", minutes: 30 } } });
    expect(c.errors.join(" ")).toMatch(/isn't an IANA time zone/);
    expect(c.errors.join(" ")).toMatch(/"api" can't be an event type id/);
    expect([...c.types.values()].every((t) => !t.on)).toBe(true);
    const r = withConfig({ owner: { weekly: { mon: [["09:00", "08:00"]] } } });
    expect(r.errors.join(" ")).toMatch(/ends before it starts/);
  });
  it("a type's own weekly hours narrow the owner's", () => {
    expect(intersectRanges([[540, 1020]], [[600, 960]])).toEqual([[600, 960]]);
    const c = withConfig({ types: { x: { name: "X", minutes: 30, locations: ["video"], weekly: { mon: [["08:00", "10:00"]] } } } });
    expect(c.types.get("x").weekly.mon).toEqual([[540, 600]]);
    expect(c.types.get("x").weekly.tue).toEqual([]);
  });
  it("the shipped booking.json is valid", async () => {
    const shipped = (await import("../booking.json")).default;
    expect(checkConfig(shipped).errors).toEqual([]);
  });
});

describe("slots", () => {
  const now = Date.UTC(2026, 2, 2, 8, 0); // Mon 08:00 London
  it("respects minimum notice, step and range end", () => {
    const s = freeSlots(cfg, t30, { ...empty, now, fromMs: now, toMs: now + DAY });
    expect(iso(s[0])).toBe("2026-03-02T12:00:00.000Z"); // 4 hours' notice
    expect(iso(s[s.length - 1])).toBe("2026-03-02T16:30:00.000Z"); // last 30-min start before 17:00
    expect((s[1] - s[0]) / MIN).toBe(15);
  });
  it("respects the horizon", () => {
    const s = freeSlots(cfg, t30, { ...empty, now, fromMs: now + 59 * DAY, toMs: now + 62 * DAY });
    expect(Math.max(...s)).toBeLessThanOrEqual(now + 60 * DAY);
  });
  it("holidays, days off and different hours on one date", () => {
    expect(dayStarts(cfg, t30, "2026-04-03", new Map())).toEqual([]); // holiday (a Friday)
    const ex = new Map([["2026-03-04", { kind: "off" }], ["2026-03-05", { kind: "hours", ranges: [[600, 660]] }]]);
    expect(dayStarts(cfg, t30, "2026-03-04", ex)).toEqual([]);
    expect(dayStarts(cfg, t30, "2026-03-05", ex).map(iso)).toEqual(["2026-03-05T10:00:00.000Z", "2026-03-05T10:15:00.000Z", "2026-03-05T10:30:00.000Z"]);
  });
  it("busy times are padded by the buffer on both sides; claimed cells block", () => {
    const start = Date.UTC(2026, 2, 3, 10, 0) / MIN;
    const s = freeSlots(cfg, t30, { ...empty, now, fromMs: Date.UTC(2026, 2, 3), toMs: Date.UTC(2026, 2, 4), busy: [[start, start + 30]] });
    // 09:15 would end 09:45 + 15 buffer = 10:00: allowed; 09:30 isn't.
    expect(s.map(iso)).toContain("2026-03-03T09:15:00.000Z");
    expect(s.map(iso)).not.toContain("2026-03-03T09:30:00.000Z");
    expect(s.map(iso)).not.toContain("2026-03-03T10:30:00.000Z");
    expect(s.map(iso)).toContain("2026-03-03T10:45:00.000Z");
    const cells = new Set(cellsFor(cfg.types.get("60min"), Date.UTC(2026, 2, 3, 9, 30)));
    const s2 = freeSlots(cfg, t30, { ...empty, now, cells, fromMs: Date.UTC(2026, 2, 3), toMs: Date.UTC(2026, 2, 4) });
    expect(s2.map(iso)).not.toContain("2026-03-03T10:00:00.000Z"); // a 60 at 09:30 and a 30 at 10:00 can't both exist
    expect(s2.map(iso)).toContain("2026-03-03T13:00:00.000Z");
  });
  it("daily caps per type and overall, in the owner's days", () => {
    const counts = new Map([["2026-03-03|30min", 4]]);
    const s = freeSlots(cfg, t30, { ...empty, now, counts, fromMs: Date.UTC(2026, 2, 3), toMs: Date.UTC(2026, 2, 5) });
    expect(s.some((t) => localDate("Europe/London", t) === "2026-03-03")).toBe(false);
    expect(s.some((t) => localDate("Europe/London", t) === "2026-03-04")).toBe(true);
    const all = freeSlots(cfg, cfg.types.get("15min"), { ...empty, now, counts: new Map([["2026-03-04|*", 6]]), fromMs: Date.UTC(2026, 2, 4), toMs: Date.UTC(2026, 2, 5) });
    expect(all).toEqual([]);
  });
  it("DST: 09:00 London is 09:00Z before 29 March and 08:00Z after; a New York visitor sees 04:00 then 05:00 then 04:00", () => {
    const before = dayStarts(cfg, t30, "2026-03-27", new Map())[0];
    const after = dayStarts(cfg, t30, "2026-03-30", new Map())[0];
    const mid = dayStarts(cfg, t30, "2026-03-10", new Map())[0]; // NY already on EDT, London still GMT
    expect(iso(before)).toBe("2026-03-27T09:00:00.000Z");
    expect(iso(after)).toBe("2026-03-30T08:00:00.000Z");
    expect(formatWhen(mid, "America/New_York")).toMatch(/05:00/);
    expect(formatWhen(Date.UTC(2026, 2, 2, 9), "America/New_York")).toMatch(/04:00/);
    expect(formatWhen(after, "America/New_York")).toMatch(/04:00/);
  });
  it("an owner range across a spring-forward gap is still its real length", () => {
    const c = withConfig({ owner: { weekly: { sun: [["00:00", "04:00"]] } } });
    const t = c.types.get("15min");
    const starts = dayStarts(c, t, "2026-03-29", new Map());
    // 00:00 GMT to 04:00 BST is 3 real hours: 12 starts of 15 minutes.
    expect(starts.length).toBe(12);
    expect(iso(starts[0])).toBe("2026-03-29T00:00:00.000Z");
    expect(iso(starts[starts.length - 1])).toBe("2026-03-29T02:45:00.000Z");
  });
  it("fall back: the full range is offered across the repeated hour", () => {
    const c = withConfig({ owner: { weekly: { sun: [["00:00", "03:00"]] } } });
    const starts = dayStarts(c, c.types.get("15min"), "2026-10-25", new Map());
    expect(starts.length).toBe(16); // 4 real hours
  });
  it("owner in Kathmandu (+05:45) on a 60-minute grid: slots on local hours", () => {
    const c = checkConfig({ ...TEST_CONFIG, owner: { ...TEST_CONFIG.owner, timeZone: "Asia/Kathmandu" }, defaults: { ...TEST_CONFIG.defaults, stepMinutes: 60 }, types: { h: { name: "H", minutes: 60, locations: ["video"] } } });
    expect(c.errors).toEqual([]);
    const s = dayStarts(c, c.types.get("h"), "2026-03-02", new Map());
    expect(formatWhen(s[0], "Asia/Kathmandu")).toMatch(/09:00/);
    expect(s[0] % (15 * MIN)).toBe(0);
  });
  it("ruleProblem refuses off-grid, too-soon, too-far and out-of-hours starts", () => {
    const ex = new Map();
    expect(ruleProblem(cfg, t30, Date.UTC(2026, 2, 3, 9, 5), now, ex)).toMatch(/offered/);
    expect(ruleProblem(cfg, t30, Date.UTC(2026, 2, 2, 10), now, ex)).toMatch(/notice/);
    expect(ruleProblem(cfg, t30, now + 70 * DAY, now, ex)).toMatch(/days ahead/);
    expect(ruleProblem(cfg, t30, Date.UTC(2026, 2, 3, 12, 0), now, ex)).toMatch(/offered/); // lunch gap
    expect(ruleProblem(cfg, t30, Date.UTC(2026, 2, 3, 9, 0), now, ex)).toBeNull();
  });
  it("nearest free times around a taken one", () => {
    const n = nearest(cfg, t30, Date.UTC(2026, 2, 3, 10), { ...empty, now });
    // 09:45 and 10:15 are 15 minutes away; of the two 30 minutes away, the earlier wins.
    expect(n.map(iso)).toEqual(["2026-03-03T09:30:00.000Z", "2026-03-03T09:45:00.000Z", "2026-03-03T10:15:00.000Z"]);
  });
});

describe("visitor input, escaping and headers", () => {
  it("checks details", () => {
    expect(checkDetails(cfg, t30, { name: "", email: "x", location: "nope" }).errors).toMatchObject({ name: expect.any(String), email: expect.any(String), location: expect.any(String) });
    expect(checkDetails(cfg, t30, { name: "A", email: "a@b.co", location: "phone" }).errors.phone).toMatch(/needed/);
    const ok = checkDetails(cfg, t30, { name: "  Ada\r\nBcc: x@y.z ", email: "ADA@Example.org", location: "video" });
    expect(ok.value.name).toBe("Ada Bcc: x@y.z");
    expect(ok.value.email).toBe("ada@example.org");
    expect(isEmail("a@b.co, c@d.co")).toBe(false);
    expect(isEmail("Name <a@b.co>")).toBe(false);
    expect(oneLine("a b", 10)).toBe("a b");
  });
  it("MIME: no header injection, RFC 2047 for non-ASCII, calendar part and attachment", async () => {
    const raw = mime({ from: "Bookings <b@example.com>", to: "sam@example.com", replyTo: "ada@example.org", subject: "New booking: Zoë\r\nBcc: evil@x.com", text: "hi", html: "<p>hi</p>", calendar: { method: "REQUEST", ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" } });
    const headers = raw.split("\r\n\r\n")[0];
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(raw).toContain("Content-Type: multipart/mixed");
    expect(raw).toContain("Content-Type: text/calendar; method=REQUEST; charset=utf-8");
    expect(raw).toContain('Content-Disposition: attachment; filename="invite.ics"');
    expect(headerSafe("a\nb")).toBe("a b");
    expect(encodeHeader("plain")).toBe("plain");
  });
  it("visitor names: 60 characters, no links; HTML always escaped", async () => {
    expect(safeName("Ada https://evil.example/x www.spam.com Lovelace")).toBe("Ada Lovelace");
    expect(safeName("x".repeat(100))).toHaveLength(60);
    expect(escapeHtml(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&#39;");
    const app = { cfg, env: { LINK_SECRET: "test-link-secret-0123456789" }, base: "https://booking.test", host: "booking.test", now: () => Date.UTC(2026, 2, 2) };
    const b = { id: "bk_aaaaaaaaaaaaaaaa", type_id: "30min", start_ms: Date.UTC(2026, 2, 3, 9), end_ms: Date.UTC(2026, 2, 3, 9, 30), status: "confirmed", name: "<img src=x onerror=alert(1)>", email: "ada@example.org", notes: "<b>hi</b>", location_key: "video", location_detail: "https://meet.example.com/sam", sequence: 0, manage_version: 1, visitor_tz: "America/New_York" };
    const m = await buildEmail(app, { kind: "owner_new", sequence: 0 }, b);
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;img src=x");
    expect(m.html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(m.replyTo).toBe("ada@example.org");
    expect(m.text).toContain("their time:");
  });
  it("CSV cells never run as formulas", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});

describe("calendar invites", () => {
  const b = { id: "bk_aaaaaaaaaaaaaaaa", start_ms: Date.UTC(2026, 2, 3, 9), end_ms: Date.UTC(2026, 2, 3, 9, 30), sequence: 2 };
  it("UID, SEQUENCE, UTC times, METHOD, escaping, alarm", () => {
    const ev = vevent({ booking: b, host: "booking.test", summary: "Call; with, Ada\\", description: "line1\nline2", location: "x", status: "CONFIRMED", organizer: { name: 'Sam "S"', email: "sam@example.com" }, attendee: { name: "Ada", email: "ada@example.org" }, alarmMinutes: 1440, stamp: 0 });
    const text = calendar("REQUEST", [ev]);
    expect(text).toContain("METHOD:REQUEST\r\n");
    expect(text).toContain("UID:bk_aaaaaaaaaaaaaaaa@booking.test\r\n");
    expect(text).toContain("SEQUENCE:2\r\n");
    expect(text).toContain("DTSTART:20260303T090000Z\r\n");
    expect(text).toContain("SUMMARY:Call\\; with\\, Ada\\\\\r\n");
    expect(text).toContain("DESCRIPTION:line1\\nline2\r\n");
    expect(text).toContain('ORGANIZER;CN="Sam S":mailto:sam@example.com');
    expect(text).toContain("TRIGGER:-PT1440M");
    const cancel = calendar("CANCEL", [vevent({ booking: { ...b, sequence: 3 }, host: "booking.test", summary: "x", status: "CANCELLED", stamp: 0, alarmMinutes: 60 })]);
    expect(cancel).toContain("METHOD:CANCEL");
    expect(cancel).toContain("STATUS:CANCELLED");
    expect(cancel).toContain("SEQUENCE:3");
    expect(cancel).not.toContain("VALARM");
  });
  it("folds lines at 75 octets without splitting characters", () => {
    const line = `DESCRIPTION:${"é".repeat(60)}`;
    const folded = fold(line);
    for (const l of folded.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").map((l, i) => (i ? l.slice(1) : l)).join("")).toBe(line);
    expect(icsText("a\r\nb")).toBe("a\\nb");
  });
  it("reminders are only created if they'd be due in the future", () => {
    const now = Date.UTC(2026, 2, 3, 8, 30);
    const plan = deliveryPlan(cfg, t30, { start_ms: Date.UTC(2026, 2, 3, 9), status: "confirmed", turnstile: "passed" }, "confirmed", 0, now);
    expect(plan.map((p) => p.kind)).toEqual(["owner_new"]); // 24 h and 1 h before are both past
  });
});

describe("signed links and rate-limit keys", () => {
  const env = { LINK_SECRET: "test-link-secret-0123456789" };
  it("expire, can't be tampered with, and are revoked by manage_version or a new secret", async () => {
    const now = Date.UTC(2026, 2, 2);
    const t = await signToken(env, "bk_aaaaaaaaaaaaaaaa", "manage", 1, now + HOUR);
    expect(await verifyToken(env, "bk_aaaaaaaaaaaaaaaa", "manage", 1, t, now)).toBe(true);
    expect(await verifyToken(env, "bk_aaaaaaaaaaaaaaaa", "manage", 1, t, now + 2 * HOUR)).toBe(false);
    expect(await verifyToken(env, "bk_bbbbbbbbbbbbbbbb", "manage", 1, t, now)).toBe(false);
    expect(await verifyToken(env, "bk_aaaaaaaaaaaaaaaa", "approve", 1, t, now)).toBe(false);
    expect(await verifyToken(env, "bk_aaaaaaaaaaaaaaaa", "manage", 2, t, now)).toBe(false);
    const [exp, sig] = t.split(".");
    expect(await verifyToken(env, "bk_aaaaaaaaaaaaaaaa", "manage", 1, `${Number(exp) + 3600}.${sig}`, now)).toBe(false);
    expect(await verifyToken({ LINK_SECRET: "another-secret-0123456789" }, "bk_aaaaaaaaaaaaaaaa", "manage", 1, t, now)).toBe(false);
    expect(await verifyToken({ LINK_SECRET: "short" }, "bk_aaaaaaaaaaaaaaaa", "manage", 1, t, now)).toBe(false);
  });
  it("rate keys change every day and group IPv6 by /64", async () => {
    const a = await rateKey("salt-0123456789abcdef", "2026-03-02", "hold", "203.0.113.7");
    const b = await rateKey("salt-0123456789abcdef", "2026-03-03", "hold", "203.0.113.7");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(networkOf("2001:db8:1:2:aaaa::1")).toBe(networkOf("2001:db8:1:2:bbbb::9"));
  });
});
