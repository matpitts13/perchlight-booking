// Time zones with Intl.DateTimeFormat only (built into Workers with full IANA
// data; no Temporal, no dependencies).
//
// Rules: availability is wall-clock time in the owner's zone; bookings are
// UTC instants; visitors see instants in their own zone.
// Wall time -> instant follows Temporal's "compatible" choice for ambiguous
// times (fall back: the earlier instant, unless asked for the later one); a
// wall time inside a spring-forward gap moves to the first valid instant
// after the gap (the transition itself).

const MIN = 60_000;
const DAY = 86_400_000;
const fmts = new Map();
const valid = new Map();
const offsets = new Map();

function fmt(zone) {
  let f = fmts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    fmts.set(zone, f);
  }
  return f;
}

/** True for a zone name the runtime knows (IANA, e.g. "Europe/London", or "UTC"). */
export function isZone(zone) {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  let ok = valid.get(zone);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      ok = true;
    } catch {
      ok = false;
    }
    if (valid.size > 2000) valid.clear();
    valid.set(zone, ok);
  }
  return ok;
}

/** Wall-clock parts of an instant in a zone. */
export function wallOf(zone, ms) {
  const p = {};
  for (const { type, value } of fmt(zone).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** The zone's UTC offset at an instant, in ms (cached per 15-minute bucket:
 *  today's transitions all fall on quarter hours in UTC). */
export function offsetMs(zone, ms) {
  const bucket = Math.floor(ms / (15 * MIN));
  let m = offsets.get(zone);
  if (!m) {
    m = new Map();
    offsets.set(zone, m);
  }
  let o = m.get(bucket);
  if (o === undefined) {
    const at = bucket * 15 * MIN;
    const w = wallOf(zone, at);
    o = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - at;
    if (m.size > 50000) m.clear();
    m.set(bucket, o);
  }
  return o;
}

/**
 * A wall-clock time in a zone -> UTC ms.
 * prefer: "earlier" (default) or "later", for a time that happens twice.
 */
export function wallToUtc(zone, y, mo, d, h = 0, mi = 0, s = 0, prefer = "earlier") {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const before = offsetMs(zone, guess - DAY);
  const after = offsetMs(zone, guess + DAY);
  // No offset change within a day either side (almost always): one answer.
  if (before === after && offsetMs(zone, guess - before) === before) return guess - before;
  const t1 = guess - before;
  const t2 = guess - after;
  const ok1 = t1 + offsetMs(zone, t1) === guess;
  const ok2 = t2 + offsetMs(zone, t2) === guess;
  if (ok1 && ok2 && t1 !== t2) return prefer === "later" ? Math.max(t1, t2) : Math.min(t1, t2);
  if (ok1) return t1;
  if (ok2) return t2;
  // Checked a day either side; an offset change closer than that (rare) is
  // found by trying the offset at the guess itself.
  const mid = guess - offsetMs(zone, guess);
  if (mid + offsetMs(zone, mid) === guess) return mid;
  // In a gap: the first instant after it, i.e. the transition.
  let lo = Math.min(t1, t2);
  let hi = Math.max(t1, t2);
  const offLo = offsetMs(zone, lo);
  while (hi - lo > MIN) {
    const m = Math.floor((lo + hi) / 2 / MIN) * MIN;
    if (m <= lo || m >= hi) break;
    if (offsetMs(zone, m) === offLo) lo = m;
    else hi = m;
  }
  return hi;
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function localDate(zone, ms) {
  const w = wallOf(zone, ms);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

/** Minutes since local midnight of an instant in a zone. */
export function localMinutes(zone, ms) {
  const w = wallOf(zone, ms);
  return w.h * 60 + w.mi;
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM-DD" -> { y, mo, d }, or null. */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? { y, mo, d } : null;
}

/** Calendar arithmetic on "YYYY-MM-DD" (no zone involved). */
export function addDays(date, n) {
  const p = parseDate(date);
  return new Date(Date.UTC(p.y, p.mo - 1, p.d + n)).toISOString().slice(0, 10);
}

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function weekday(date) {
  const p = parseDate(date);
  return WEEKDAYS[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()];
}

/** Local midnight of a date in a zone, as UTC ms (a gap at midnight moves forward). */
export function startOfDay(zone, date) {
  const p = parseDate(date);
  return wallToUtc(zone, p.y, p.mo, p.d, 0, 0, 0, "earlier");
}

const shows = new Map();
/** "Tue 3 Mar 2026, 09:00 (GMT+1)" in a zone, for emails and pages. */
export function formatWhen(ms, zone, { weekdayStyle = "long" } = {}) {
  const key = `${zone}|${weekdayStyle}`;
  let f = shows.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: weekdayStyle,
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "shortOffset",
    });
    shows.set(key, f);
  }
  return f.format(new Date(ms));
}

/** "09:00" in a zone. */
export function formatTime(ms, zone) {
  const w = wallOf(zone, ms);
  return `${pad(w.h)}:${pad(w.mi)}`;
}

/** "UTC+05:45" style offset label of an instant in a zone. */
export function offsetLabel(zone, ms) {
  const o = offsetMs(zone, ms) / MIN;
  const sign = o < 0 ? "-" : "+";
  const a = Math.abs(o);
  return `UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Tests only. */
export function clearZoneCaches() {
  fmts.clear();
  valid.clear();
  offsets.clear();
}
