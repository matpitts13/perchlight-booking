import { describe, it, expect, beforeEach } from "vitest";
import { parseIcs, parseRule, splitProp, MAX_ITERATIONS } from "../src/lib/ics-parse.js";
import { fetchFeed } from "../src/lib/busy.js";
import { localDate, formatTime } from "../src/lib/tz.js";
import googleExport from "./fixtures/google-export.ics?raw";
import { ics, appFor, mockFetch, resetAll } from "./helpers.js";

const MIN = 60_000;
const DAY = 86_400_000;
const NY = "America/New_York";
const iso = (m) => new Date(m * MIN).toISOString();

/** Expands one series (1-hour events) and returns its local start dates in New York. */
function dates(rrule, dtstart, extra = [], { now = Date.UTC(1997, 0, 1), years = 12 } = {}) {
  const text = ics([`UID:x@test`, `DTSTART;TZID=${NY}:${dtstart}`, "DURATION:PT1H", `RRULE:${rrule}`, ...extra]);
  const r = parseIcs(text, { ownerZone: "Europe/London", now, until: now + years * 365 * DAY });
  return r.intervals.map(([s]) => localDate(NY, s * MIN).replace(/-/g, ""));
}

describe("ICS parsing", () => {
  it("unfolds lines and reads quoted parameters", () => {
    expect(splitProp('ATTENDEE;CN="Doe: Jane";ROLE=X:mailto:j@x.com')).toEqual({ name: "ATTENDEE", params: { CN: "Doe: Jane", ROLE: "X" }, value: "mailto:j@x.com" });
    const text = ics(["UID:a", "DTSTART:20260303T09", " 0000Z", "DTEND:20260303T100000Z"]);
    const r = parseIcs(text, { ownerZone: "Europe/London", now: Date.UTC(2026, 2, 1), until: Date.UTC(2026, 4, 1) });
    expect(r.intervals.map(([a, b]) => [iso(a), b - a])).toEqual([["2026-03-03T09:00:00.000Z", 60]]);
  });

  describe("RFC 5545 §3.8.5.3 examples", () => {
    it("daily for 10 occurrences", () => {
      expect(dates("FREQ=DAILY;COUNT=10", "19970902T090000")).toEqual(["19970902", "19970903", "19970904", "19970905", "19970906", "19970907", "19970908", "19970909", "19970910", "19970911"]);
    });
    it("every other day, until a date", () => {
      expect(dates("FREQ=DAILY;INTERVAL=2;UNTIL=19970912T000000Z", "19970902T090000")).toEqual(["19970902", "19970904", "19970906", "19970908", "19970910"]);
    });
    it("every other week on Tuesday and Thursday", () => {
      expect(dates("FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=TU,TH;COUNT=8", "19970902T090000")).toEqual(["19970902", "19970904", "19970916", "19970918", "19970930", "19971002", "19971014", "19971016"]);
    });
    it("WKST changes the result (MO vs SU)", () => {
      expect(dates("FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO", "19970805T090000")).toEqual(["19970805", "19970810", "19970819", "19970824"]);
      expect(dates("FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU", "19970805T090000")).toEqual(["19970805", "19970817", "19970819", "19970831"]);
    });
    it("monthly on the first Friday, and the second-to-last Monday", () => {
      expect(dates("FREQ=MONTHLY;COUNT=6;BYDAY=1FR", "19970905T090000")).toEqual(["19970905", "19971003", "19971107", "19971205", "19980102", "19980206"]);
      expect(dates("FREQ=MONTHLY;COUNT=6;BYDAY=-2MO", "19970922T090000")).toEqual(["19970922", "19971020", "19971117", "19971222", "19980119", "19980216"]);
    });
    it("the third-to-last day of the month", () => {
      expect(dates("FREQ=MONTHLY;BYMONTHDAY=-3;COUNT=6", "19970928T090000")).toEqual(["19970928", "19971029", "19971128", "19971229", "19980129", "19980226"]);
    });
    it("the last work day of the month (BYSETPOS)", () => {
      expect(dates("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=7", "19970930T090000")).toEqual(["19970930", "19971031", "19971128", "19971231", "19980130", "19980227", "19980331"]);
    });
    it("yearly in June and July", () => {
      expect(dates("FREQ=YEARLY;COUNT=6;BYMONTH=6,7", "19970610T090000")).toEqual(["19970610", "19970710", "19980610", "19980710", "19990610", "19990710"]);
    });
    it("every Friday the 13th (with DTSTART excluded)", () => {
      expect(dates("FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13;COUNT=6", "19970902T090000", ["EXDATE;TZID=America/New_York:19970902T090000"])).toEqual(["19980213", "19980313", "19981113", "19990813", "20001013"]);
    });
    it("US presidential election day (every 4 years)", () => {
      expect(dates("FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8;COUNT=3", "19961105T090000", [], { now: Date.UTC(1996, 0, 1) })).toEqual(["19961105", "20001107", "20041102"]);
    });
    it("invalid dates are skipped (the 30th of February)", () => {
      expect(dates("FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5", "20070115T090000", [], { now: Date.UTC(2007, 0, 1) })).toEqual(["20070115", "20070130", "20070215", "20070315", "20070330"]);
    });
  });

  it("a weekly 09:00 meeting stays at 09:00 New York time across DST", () => {
    const now = Date.UTC(2026, 2, 1);
    const text = ics([`UID:w`, `DTSTART;TZID=${NY}:20260302T090000`, `DTEND;TZID=${NY}:20260302T100000`, "RRULE:FREQ=WEEKLY;COUNT=3"]);
    const r = parseIcs(text, { ownerZone: "Europe/London", now, until: now + 60 * DAY });
    expect(r.intervals.map(([a]) => iso(a))).toEqual(["2026-03-02T14:00:00.000Z", "2026-03-09T13:00:00.000Z", "2026-03-16T13:00:00.000Z"]);
    expect(r.intervals.every(([a]) => formatTime(a * MIN, NY) === "09:00")).toBe(true);
  });

  it("UNTIL in UTC while DTSTART is in New York", () => {
    const now = Date.UTC(2026, 2, 1);
    const text = ics(["UID:u", `DTSTART;TZID=${NY}:20260302T200000`, "DURATION:PT30M", "RRULE:FREQ=DAILY;UNTIL=20260305T005959Z"]);
    const r = parseIcs(text, { ownerZone: "Europe/London", now, until: now + 30 * DAY });
    expect(r.intervals.map(([a]) => iso(a))).toEqual(["2026-03-03T01:00:00.000Z", "2026-03-04T01:00:00.000Z"]);
  });

  it("year boundaries and 29 February", () => {
    const leap = dates("FREQ=YEARLY;COUNT=3", "20240229T090000", [], { now: Date.UTC(2024, 0, 1), years: 13 });
    expect(leap).toEqual(["20240229", "20280229", "20320229"]);
    expect(dates("FREQ=WEEKLY;COUNT=3", "20261231T090000", [], { now: Date.UTC(2026, 11, 1) })).toEqual(["20261231", "20270107", "20270114"]);
  });

  it("long-running series are fast-forwarded to now (no COUNT)", () => {
    const now = Date.UTC(2026, 2, 1);
    const text = ics(["UID:old", `DTSTART;TZID=${NY}:20050103T090000`, "DURATION:PT1H", "RRULE:FREQ=DAILY"]);
    const r = parseIcs(text, { ownerZone: "Europe/London", now, until: now + 10 * DAY });
    expect(r.intervals).toHaveLength(10);
    expect(r.stats.unsupported).toEqual([]);
  });

  it("EXDATE, RDATE and RECURRENCE-ID (moved and cancelled instances)", () => {
    const now = Date.UTC(2026, 2, 1);
    const text = ics(
      ["UID:s", "DTSTART:20260302T100000Z", "DTEND:20260302T110000Z", "RRULE:FREQ=DAILY;COUNT=5", "EXDATE:20260303T100000Z,20260304T100000Z", "RDATE:20260310T150000Z", "RDATE;VALUE=PERIOD:20260311T150000Z/PT2H"],
      ["UID:s", "RECURRENCE-ID:20260305T100000Z", "DTSTART:20260305T160000Z", "DTEND:20260305T170000Z"],
      ["UID:s", "RECURRENCE-ID:20260306T100000Z", "DTSTART:20260306T100000Z", "DTEND:20260306T110000Z", "STATUS:CANCELLED"],
    );
    const r = parseIcs(text, { ownerZone: "Europe/London", now, until: now + 30 * DAY });
    expect(r.intervals.map(([a, b]) => `${iso(a)}+${b - a}`)).toEqual([
      "2026-03-02T10:00:00.000Z+60",
      "2026-03-05T16:00:00.000Z+60",
      "2026-03-10T15:00:00.000Z+60",
      "2026-03-11T15:00:00.000Z+120",
    ]);
  });

  it("all-day events block the whole date in the owner's zone; free and cancelled events don't block", () => {
    const now = Date.UTC(2026, 5, 1);
    const text = ics(
      ["UID:a", "DTSTART;VALUE=DATE:20260610", "DTEND;VALUE=DATE:20260611"],
      ["UID:b", "DTSTART;VALUE=DATE:20260612", "TRANSP:TRANSPARENT"],
      ["UID:c", "DTSTART:20260613T090000Z", "DTEND:20260613T100000Z", "STATUS:CANCELLED"],
    );
    const r = parseIcs(text, { ownerZone: "Europe/London", now, until: now + 30 * DAY });
    expect(r.intervals.map(([a, b]) => [iso(a), iso(b)])).toEqual([["2026-06-09T23:00:00.000Z", "2026-06-10T23:00:00.000Z"]]); // BST
    expect(parseIcs(text, { ownerZone: "Europe/London", now, until: now + 30 * DAY, allDay: "ignore" }).intervals).toEqual([]);
  });

  it("time zones: Windows names, Mozilla-style paths, VTIMEZONE fallback, unknown zones reported", () => {
    const now = Date.UTC(2026, 0, 1);
    const vtz = [
      "BEGIN:VTIMEZONE", "TZID:My Custom Zone",
      "BEGIN:STANDARD", "DTSTART:19701025T040000", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0200", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:19700329T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0300", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
      "END:VTIMEZONE",
    ];
    const text = ics(
      ["UID:w", "DTSTART;TZID=Eastern Standard Time:20260304T100000", "DURATION:PT1H"],
      ["UID:m", "DTSTART;TZID=/mozilla.org/20050126_1/America/Chicago:20260305T100000", "DURATION:PT1H"],
      ["UID:v1", "DTSTART;TZID=My Custom Zone:20260115T100000", "DURATION:PT1H"],
      ["UID:v2", "DTSTART;TZID=My Custom Zone:20260715T100000", "DURATION:PT1H"],
      ["UID:u", "DTSTART;TZID=Nowhere Standard Time:20260201T100000", "DURATION:PT1H"],
    ).replace("BEGIN:VEVENT", `${vtz.join("\r\n")}\r\nBEGIN:VEVENT`);
    const r = parseIcs(text, { ownerZone: "Europe/London", now, until: now + 365 * DAY });
    expect(r.intervals.map(([a]) => iso(a))).toEqual([
      "2026-01-15T08:00:00.000Z", // +02:00 in winter
      "2026-02-01T10:00:00.000Z", // unknown: owner's zone (GMT)
      "2026-03-04T15:00:00.000Z", // Eastern Standard Time -> New York
      "2026-03-05T16:00:00.000Z", // America/Chicago
      "2026-07-15T07:00:00.000Z", // +03:00 in summer
    ]);
    expect(r.stats.unknownZones).toEqual(["Nowhere Standard Time"]);
    expect(r.stats.vtimezones).toBe(1);
  });

  it("unsupported rules block too much, never too little, and are reported", () => {
    const now = Date.UTC(2026, 2, 1);
    for (const rule of ["FREQ=HOURLY;INTERVAL=3", "FREQ=YEARLY;BYWEEKNO=20", "FREQ=DAILY;BYHOUR=9,15", "FREQ=DAILY;X-NAME=1"]) {
      const text = ics(["UID:h", "DTSTART:20260115T090000Z", "DURATION:PT30M", `RRULE:${rule}`]);
      const r = parseIcs(text, { ownerZone: "Europe/London", now, until: now + 10 * DAY });
      expect(r.stats.unsupported[0].rule).toBe(rule);
      expect(r.intervals.length).toBeGreaterThanOrEqual(10); // every day at 09:00 for the window
      expect(r.intervals.every(([a, b]) => formatTime(a * MIN, "UTC") === "09:00" && b - a === 30)).toBe(true);
    }
    expect(parseRule("FREQ=SECONDLY").unsupported).toMatch(/SECONDLY/);
  });

  it(`a COUNT series needing more than ${MAX_ITERATIONS} steps to reach now over-blocks`, () => {
    const now = Date.UTC(2026, 2, 1);
    const text = ics(["UID:c", "DTSTART:20000101T090000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=20000"]);
    const r = parseIcs(text, { ownerZone: "Europe/London", now, until: now + 5 * DAY });
    expect(r.stats.unsupported[0].reason).toMatch(/more than 5000/);
    expect(r.intervals.length).toBeGreaterThanOrEqual(5);
  });

  it("a Google-style export: weekly series with an excluded date and a moved instance, all-day events, our own invite ignored", () => {
    const now = Date.UTC(2026, 2, 1);
    const r = parseIcs(googleExport, { ownerZone: "Europe/London", now, until: now + 31 * DAY, uidSuffix: "@booking.test" });
    const got = r.intervals.map(([a, b]) => `${iso(a)} ${b - a}`);
    expect(got).toEqual([
      "2026-03-03T10:00:00.000Z 60", // weekly Tuesday 10:00 GMT
      "2026-03-04T13:00:00.000Z 60", // dentist (UTC)
      "2026-03-12T00:00:00.000Z 2880", // two-day conference, all day
      // 10 March excluded; 17 March moved to 14:30
      "2026-03-17T14:30:00.000Z 60",
      "2026-03-24T10:00:00.000Z 60",
      "2026-03-31T09:00:00.000Z 60", // 10:00 BST after 29 March
    ]);
    expect(r.stats).toMatchObject({ events: 8, series: 1, overrides: 1, skippedPast: 1, unsupported: [], unknownZones: [] });
  });
});

describe("fetching a feed", () => {
  beforeEach(resetAll);
  it("refuses a feed over FEED_MAX_KB instead of cutting it short", async () => {
    const big = ics(...Array.from({ length: 400 }, (_, i) => [`UID:e${i}`, "DTSTART:20260303T090000Z", "DURATION:PT1H", `DESCRIPTION:${"x".repeat(60)}`]));
    mockFetch({ feeds: { "https://cal.test/big.ics": big, "https://cal.test/len.ics": { body: "BEGIN:VCALENDAR", headers: { "Content-Length": String(10 * 1024 * 1024) } } } });
    const app = appFor({ FEED_MAX_KB: "16" });
    const r = await fetchFeed(app, { url: "https://cal.test/big.ics", kind: "calendar" }, null, Date.UTC(2026, 2, 1));
    expect(r).toMatchObject({ ok: false, tooBig: true });
    expect(r.error).toMatch(/over FEED_MAX_KB/);
    const r2 = await fetchFeed(app, { url: "https://cal.test/len.ics", kind: "calendar" }, null, Date.UTC(2026, 2, 1));
    expect(r2).toMatchObject({ ok: false, tooBig: true });
  });
  it("never puts the link in an error", async () => {
    mockFetch({ feeds: { "https://cal.test/secret-abc.ics": { status: 404 } } });
    const r = await fetchFeed(appFor(), { url: "https://cal.test/secret-abc.ics", kind: "calendar" }, null, Date.UTC(2026, 2, 1));
    expect(r.error).toBe("the calendar link answered HTTP 404");
  });
});
