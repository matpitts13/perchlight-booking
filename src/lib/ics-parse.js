// Busy times from an iCalendar (ICS) feed, with no dependencies.
//
// A single pass over the text: lines are unfolded (RFC 5545 §3.1) only for
// the properties that matter, and only VEVENT and VTIMEZONE blocks are read.
// Summaries, descriptions, attendees and locations are skipped without being
// kept: only busy intervals (and counts) leave this module.
//
// Repeating events (RRULE) are expanded inside [now, horizon] in the event's
// own zone, so a 09:00 weekly meeting stays at 09:00 across DST. Supported:
// FREQ DAILY / WEEKLY / MONTHLY / YEARLY with INTERVAL, COUNT, UNTIL, WKST,
// BYDAY (with ordinals), BYMONTHDAY (also negative), BYMONTH, BYSETPOS; plus
// EXDATE, RDATE and RECURRENCE-ID overrides. Anything else (HOURLY, BYWEEKNO,
// BYHOUR...) blocks that time of day, every day, for the whole horizon: too
// much, never too little. Such series are listed in the stats.
import { isZone, wallToUtc, startOfDay } from "./tz.js";
import { WINDOWS_ZONES } from "./winzones.js";

const DAY = 86_400_000;
const MIN = 60_000;
export const MAX_ITERATIONS = 5000;
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const SUPPORTED_FREQ = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const UNSUPPORTED_PARTS = new Set(["BYYEARDAY", "BYWEEKNO", "BYHOUR", "BYMINUTE", "BYSECOND"]);
const KNOWN_PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "WKST", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS"]);
const EVENT_PROPS = new Set(["DTSTART", "DTEND", "DURATION", "RRULE", "RDATE", "EXDATE", "RECURRENCE-ID", "STATUS", "TRANSP", "UID"]);
const TZ_PROPS = new Set(["TZID", "DTSTART", "TZOFFSETFROM", "TZOFFSETTO", "RRULE"]);

/** "NAME;P=V;Q="a:b":value" -> { name, params, value }, or null. */
export function splitProp(line) {
  let q = false;
  let colon = -1;
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c === 34) q = !q;
    else if (c === 58 && !q) {
      colon = k;
      break;
    }
  }
  if (colon < 1) return null;
  const head = line.slice(0, colon);
  const semi = head.indexOf(";");
  const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
  const params = {};
  if (semi >= 0) {
    for (const p of head.slice(semi + 1).match(/(?:[^;"]|"[^"]*")+/g) ?? []) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
    }
  }
  return { name, params, value: line.slice(colon + 1) };
}

/** "20260310T090000Z" / "20260310T090000" / "20260310" -> parts, or null. */
export function parseDt(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const date = !m[4] || params.VALUE === "DATE";
  // Impossible dates and times (20270230, 25:00) are refused, not guessed.
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || s > 60) return null;
  return {
    y: +m[1], mo: +m[2], d: +m[3],
    h: date ? 0 : +m[4], mi: date ? 0 : +m[5], s: date ? 0 : Math.min(+m[6], 59),
    utc: Boolean(m[7]), date, tzid: params.TZID ?? null,
  };
}

/** "PT1H30M" / "P1D" -> { ms, days } (days only for whole-day durations), or null. */
export function parseDuration(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s).trim());
  if (!m || s.trim() === "P" || s.trim() === "PT") return null;
  const sign = m[1] === "-" ? -1 : 1;
  const days = (+(m[2] ?? 0)) * 7 + +(m[3] ?? 0);
  const ms = (days * 24 * 3600 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return { ms: sign * ms, days: sign * days, timed: Boolean(m[4] || m[5] || m[6]) };
}

/** RRULE text -> rule, with `unsupported` set to a reason if it can't be expanded exactly. */
export function parseRule(text) {
  const r = { freq: null, interval: 1, count: null, until: null, wkst: 1, byday: null, bymonthday: null, bymonth: null, bysetpos: null, unsupported: null };
  const bad = (why) => {
    r.unsupported ??= why;
  };
  for (const part of String(text).split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = part.slice(0, eq).toUpperCase();
    const v = part.slice(eq + 1).toUpperCase();
    if (UNSUPPORTED_PARTS.has(k)) bad(`${k} isn't supported`);
    else if (!KNOWN_PARTS.has(k)) bad(`${k || part} isn't supported`);
    else if (k === "FREQ") {
      r.freq = v;
      if (!SUPPORTED_FREQ.has(v)) bad(`FREQ=${v} isn't supported`);
    } else if (k === "INTERVAL") {
      if (!/^\d{1,4}$/.test(v) || +v < 1) bad("bad INTERVAL");
      else r.interval = +v;
    } else if (k === "COUNT") {
      if (!/^\d{1,6}$/.test(v) || +v < 1) bad("bad COUNT");
      else r.count = +v;
    } else if (k === "UNTIL") {
      r.until = parseDt(v);
      if (!r.until) bad("bad UNTIL");
    } else if (k === "WKST") {
      if (!(v in WD)) bad("bad WKST");
      else r.wkst = WD[v];
    } else if (k === "BYDAY") {
      r.byday = v.split(",").map((x) => {
        const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x);
        if (!m) bad("bad BYDAY");
        return m ? { n: m[1] ? +m[1] : 0, wd: WD[m[2]] } : { n: 0, wd: 0 };
      });
    } else {
      const nums = v.split(",").map((x) => (/^[+-]?\d{1,3}$/.test(x) ? +x : NaN));
      if (nums.some((n) => !Number.isFinite(n) || n === 0)) bad(`bad ${k}`);
      if (k === "BYMONTHDAY") r.bymonthday = nums;
      else if (k === "BYMONTH") r.bymonth = nums;
      else r.bysetpos = nums;
    }
  }
  if (!r.freq) bad("no FREQ");
  if (r.count !== null && r.until !== null) bad("COUNT and UNTIL together");
  return r;
}

// --- calendar arithmetic on day numbers (days since 1970-01-01, no zone) ---
const dayNum = (y, mo, d) => Math.floor(Date.UTC(y, mo - 1, d) / DAY);
function fromDay(n) {
  const t = new Date(n * DAY);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const dow = (n) => (((n + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
const daysIn = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** The n-th (or -n-th from the end) weekday wd of a month, as a day number, or null. */
function nthInMonth(y, mo, wd, n) {
  const dim = daysIn(y, mo);
  if (n > 0) {
    const d = ((wd - dow(dayNum(y, mo, 1)) + 7) % 7) + 1 + (n - 1) * 7;
    return d <= dim ? dayNum(y, mo, d) : null;
  }
  const d = dim - ((dow(dayNum(y, mo, dim)) - wd + 7) % 7) + (n + 1) * 7;
  return d >= 1 ? dayNum(y, mo, d) : null;
}

function nthInYear(y, wd, n) {
  const first = dayNum(y, 1, 1);
  const last = dayNum(y, 12, 31);
  const d = n > 0 ? first + ((wd - dow(first) + 7) % 7) + (n - 1) * 7 : last - ((dow(last) - wd + 7) % 7) + (n + 1) * 7;
  return d >= first && d <= last ? d : null;
}

function monthDays(y, mo, r, startD) {
  const dim = daysIn(y, mo);
  let byMd = null;
  if (r.bymonthday) {
    byMd = new Set();
    for (const n of r.bymonthday) {
      const d = n > 0 ? n : dim + 1 + n;
      if (d >= 1 && d <= dim) byMd.add(dayNum(y, mo, d));
    }
  }
  if (r.byday) {
    const out = [];
    for (const { n, wd } of r.byday) {
      if (n) {
        const d = nthInMonth(y, mo, wd, n);
        if (d !== null) out.push(d);
      } else {
        for (let d = nthInMonth(y, mo, wd, 1); d !== null && d <= dayNum(y, mo, dim); d += 7) out.push(d);
      }
    }
    return byMd ? out.filter((d) => byMd.has(d)) : out;
  }
  if (byMd) return [...byMd];
  return startD <= dim ? [dayNum(y, mo, startD)] : [];
}

/** Candidate days of the k-th period of a rule. */
function periodDays(r, k, s) {
  let days;
  if (r.freq === "DAILY") {
    days = [s.day + k * r.interval];
  } else if (r.freq === "WEEKLY") {
    const ws = s.weekStart + k * 7 * r.interval;
    const wds = r.byday ? r.byday.map((b) => b.wd) : [dow(s.day)];
    days = wds.map((wd) => ws + ((wd - r.wkst + 7) % 7));
  } else if (r.freq === "MONTHLY") {
    const idx = s.monthIdx + k * r.interval;
    days = monthDays(Math.floor(idx / 12), (idx % 12) + 1, r, s.d);
  } else {
    const y = s.y + k * r.interval;
    if (r.bymonth) days = r.bymonth.filter((m) => m >= 1 && m <= 12).flatMap((m) => monthDays(y, m, r, s.d));
    else if (r.byday && !r.bymonthday) {
      days = [];
      for (const { n, wd } of r.byday) {
        if (n) {
          const d = nthInYear(y, wd, n);
          if (d !== null) days.push(d);
        } else for (let d = nthInYear(y, wd, 1); d !== null && d <= dayNum(y, 12, 31); d += 7) days.push(d);
      }
    } else if (r.bymonthday) {
      days = [];
      for (let m = 1; m <= 12; m++) days.push(...monthDays(y, m, r, s.d));
    } else days = s.d <= daysIn(y, s.mo) ? [dayNum(y, s.mo, s.d)] : [];
  }
  // Filters that limit rather than expand at this frequency.
  if (r.bymonth && r.freq !== "YEARLY") days = days.filter((d) => r.bymonth.includes(fromDay(d).mo));
  if (r.freq === "DAILY") {
    if (r.bymonthday) days = days.filter((d) => {
      const { y, mo, d: dd } = fromDay(d);
      const dim = daysIn(y, mo);
      return r.bymonthday.some((n) => (n > 0 ? n : dim + 1 + n) === dd);
    });
    if (r.byday) days = days.filter((d) => r.byday.some((b) => b.wd === dow(d)));
  }
  days = [...new Set(days)].sort((a, b) => a - b);
  if (r.bysetpos) {
    const picked = new Set();
    for (const p of r.bysetpos) {
      const d = p > 0 ? days[p - 1] : days[days.length + p];
      if (d !== undefined) picked.add(d);
    }
    days = [...picked].sort((a, b) => a - b);
  }
  return days;
}

/** Index of the first period worth looking at for a window starting on winDay (no COUNT only). */
function firstPeriod(r, s, winDay) {
  if (winDay <= s.day) return 0;
  let k;
  if (r.freq === "DAILY") k = Math.floor((winDay - s.day) / r.interval);
  else if (r.freq === "WEEKLY") k = Math.floor((winDay - s.weekStart) / (7 * r.interval));
  else if (r.freq === "MONTHLY") {
    const w = fromDay(winDay);
    k = Math.floor((w.y * 12 + w.mo - 1 - s.monthIdx) / r.interval);
  } else k = Math.floor((fromDay(winDay).y - s.y) / r.interval);
  return Math.max(0, k - 1);
}

/**
 * Expands a rule into start days (day numbers, wall dates in the event's zone).
 * stopDay: no occurrence after this day matters. isPastUntil(day) -> true stops.
 * Returns { days, capped } (capped: gave up after MAX_ITERATIONS).
 */
export function expandDays(r, start, stopDay, winDay, isPastUntil) {
  const sDay = dayNum(start.y, start.mo, start.d);
  const s = { day: sDay, y: start.y, mo: start.mo, d: start.d, monthIdx: start.y * 12 + start.mo - 1, weekStart: sDay - ((dow(sDay) - r.wkst + 7) % 7) };
  const out = [];
  let produced = 0;
  let iter = 0;
  // DTSTART is always the first occurrence (RFC 5545 §3.8.5.3).
  if (!isPastUntil(sDay)) {
    out.push(sDay);
    produced = 1;
  }
  if (r.count !== null && produced >= r.count) return { days: out, capped: false };
  for (let k = r.count === null ? firstPeriod(r, s, winDay) : 0; ; k++) {
    if (++iter > MAX_ITERATIONS) return { days: out, capped: true };
    const days = periodDays(r, k, s);
    let periodPast = false;
    for (const d of days) {
      if (d <= sDay) continue;
      if (++iter > MAX_ITERATIONS) return { days: out, capped: true };
      if (d > stopDay || isPastUntil(d)) {
        periodPast = true;
        break;
      }
      out.push(d);
      produced++;
      if (r.count !== null && produced >= r.count) return { days: out, capped: false };
    }
    if (periodPast) return { days: out, capped: false };
    // A period that starts after stopDay can't produce anything earlier.
    const probe = r.freq === "DAILY" ? s.day + k * r.interval
      : r.freq === "WEEKLY" ? s.weekStart + k * 7 * r.interval
      : r.freq === "MONTHLY" ? (() => { const idx = s.monthIdx + k * r.interval; return dayNum(Math.floor(idx / 12), (idx % 12) + 1, 1); })()
      : dayNum(s.y + k * r.interval, 1, 1);
    if (probe > stopDay) return { days: out, capped: false };
  }
}

/**
 * Parses an ICS feed into busy intervals.
 * @param {string} text
 * @param {{ ownerZone: string, now: number, until: number, uidSuffix?: string, allDay?: "busy" | "ignore" }} o
 * @returns {{ intervals: number[][], stats: object }} intervals: [startMinute, endMinute] (minutes since epoch), merged
 */
export function parseIcs(text, o) {
  const { ownerZone, now, until } = o;
  // Our own booking invites (accepted into your calendar) are ignored: UID "bk_<16>@<a host we used>".
  const ownHosts = new Set((o.ownHosts ?? (o.uidSuffix ? [o.uidSuffix.replace(/^@/, "")] : [])).map((h) => String(h).toLowerCase()));
  const stats = { bytes: text.length, events: 0, series: 0, skippedPast: 0, overrides: 0, unsupported: [], unknownZones: [], vtimezones: 0 };
  const masters = [];
  const overrides = new Map(); // uid -> [{ rid, ev }]
  const vtz = new Map();
  const pastCut = ymd(now - 2 * DAY);

  // Scans with indexOf rather than split(): no array of every line, and a
  // line is only sliced when its first letter could start a property we read
  // (most of a feed is DESCRIPTION, ATTENDEE, SUMMARY... and is skipped).
  const len = text.length;
  let pos = 0;
  let ev = null;
  let nested = 0;
  let tz = null;
  let sub = null;
  const lineAt = (from) => {
    const nl = text.indexOf("\n", from);
    const stop = nl < 0 ? len : nl;
    return { end: text.charCodeAt(stop - 1) === 13 ? stop - 1 : stop, next: stop + 1 };
  };
  while (pos < len) {
    const { end, next } = lineAt(pos);
    const c0 = text.charCodeAt(pos) | 32; // lower-case letter (or space/tab: a continuation)
    const start = pos;
    pos = next;
    if (end <= start || c0 === 32 || c0 === 41) continue; // empty, or a continuation of a line we skipped (space/tab)
    if (ev === null && tz === null) {
      if (c0 === 98) {
        const t = text.slice(start, end).trim().toUpperCase();
        if (t === "BEGIN:VEVENT") {
          ev = { exdate: [], rdate: [] };
          nested = 0;
        } else if (t === "BEGIN:VTIMEZONE") tz = { id: null, subs: [] };
      }
      continue;
    }
    // b(EGIN) d(TSTART/TEND/URATION) e(ND/XDATE) r(RULE/DATE/ECURRENCE-ID) s(TATUS) t(RANSP/ZID/ZOFFSET*) u(ID)
    if (c0 !== 98 && c0 !== 100 && c0 !== 101 && c0 !== 114 && c0 !== 115 && c0 !== 116 && c0 !== 117) continue;
    let line = text.slice(start, end);
    const colon = line.indexOf(":");
    const semi = line.indexOf(";");
    const cut = semi >= 0 && semi < colon ? semi : colon;
    const name = cut > 0 ? line.slice(0, cut).toUpperCase() : "";
    if (name === "BEGIN" || name === "END") {
      const what = line.slice(colon + 1).trim().toUpperCase();
      if (ev) {
        if (name === "BEGIN") nested++;
        else if (nested > 0) nested--;
        else if (what === "VEVENT") {
          finishEvent(ev);
          ev = null;
        }
      } else if (tz) {
        if (name === "BEGIN" && (what === "STANDARD" || what === "DAYLIGHT")) sub = { kind: what };
        else if (name === "END" && (what === "STANDARD" || what === "DAYLIGHT")) {
          if (sub) tz.subs.push(sub);
          sub = null;
        } else if (name === "END" && what === "VTIMEZONE") {
          if (tz.id) vtz.set(tz.id, tz);
          tz = null;
          sub = null;
        }
      }
      continue;
    }
    const wanted = ev ? nested === 0 && EVENT_PROPS.has(name) : TZ_PROPS.has(name);
    if (!wanted) continue;
    // Unfold (RFC 5545 §3.1): continuation lines start with a space or a tab.
    while (pos < len && (text.charCodeAt(pos) === 32 || text.charCodeAt(pos) === 9)) {
      const l = lineAt(pos);
      line += text.slice(pos + 1, l.end);
      pos = l.next;
    }
    const p = splitProp(line);
    if (!p) continue;
    if (ev) {
      if (p.name === "EXDATE" || p.name === "RDATE") ev[p.name.toLowerCase()].push(p);
      else ev[p.name] = p;
    } else if (sub) sub[p.name] = p.value.trim();
    else if (p.name === "TZID") tz.id = p.value.trim();
  }

  function finishEvent(e) {
    stats.events++;
    const uid = e.UID ? e.UID.value.trim() : "";
    const own = /^bk_[a-km-z2-9]{16}@(.+)$/.exec(uid.toLowerCase());
    if (own && ownHosts.has(own[1])) return;
    if (!e.DTSTART) return;
    if (e["RECURRENCE-ID"]) {
      stats.overrides++;
      if (!overrides.has(uid)) overrides.set(uid, []);
      overrides.get(uid).push(e);
      return;
    }
    if (!e.RRULE && !e.rdate.length) {
      // Cheap skip of history: the end date (or start) as text, before any zone work.
      const endVal = (e.DTEND ?? e.DTSTART).value.trim();
      if (!e.DURATION && endVal.slice(0, 8) < pastCut) {
        stats.skippedPast++;
        return;
      }
    } else stats.series++;
    masters.push({ uid, e });
  }

  // --- zones ---
  const zoneCache = new Map();
  function zoneFor(tzid) {
    if (!tzid) return { kind: "owner" };
    let z = zoneCache.get(tzid);
    if (z) return z;
    const clean = tzid.replace(/^"|"$/g, "").trim();
    const tail = clean.split("/").slice(-2).join("/");
    if (isZone(clean)) z = { kind: "iana", zone: clean };
    else if (Object.hasOwn(WINDOWS_ZONES, clean)) z = { kind: "iana", zone: WINDOWS_ZONES[clean] };
    else if (vtz.has(tzid)) {
      z = { kind: "vtz", tz: vtz.get(tzid) };
      stats.vtimezones++;
    } else if (tail !== clean && isZone(tail)) z = { kind: "iana", zone: tail }; // "/mozilla.org/.../Europe/London"
    else {
      z = { kind: "owner" };
      if (stats.unknownZones.length < 20 && !stats.unknownZones.includes(clean.slice(0, 80))) stats.unknownZones.push(clean.slice(0, 80));
    }
    zoneCache.set(tzid, z);
    return z;
  }

  function toUtc(dt, zone, prefer = "earlier") {
    if (dt.utc) return Date.UTC(dt.y, dt.mo - 1, dt.d, dt.h, dt.mi, dt.s);
    if (dt.date) return startOfDay(ownerZone, `${dt.y}-${p2(dt.mo)}-${p2(dt.d)}`);
    if (zone.kind === "iana") return wallToUtc(zone.zone, dt.y, dt.mo, dt.d, dt.h, dt.mi, dt.s, prefer);
    if (zone.kind === "vtz") return vtzToUtc(zone.tz, dt);
    return wallToUtc(ownerZone, dt.y, dt.mo, dt.d, dt.h, dt.mi, dt.s, prefer);
  }

  // --- expansion ---
  const busy = [];
  const add = (s, e) => {
    if (e > now && s < until && e > s) busy.push([Math.floor(Math.max(s, now) / MIN), Math.ceil(Math.min(e, until) / MIN)]);
  };
  const isFree = (e) => {
    const st = e.STATUS?.value.trim().toUpperCase();
    const tr = e.TRANSP?.value.trim().toUpperCase();
    // Holiday feeds mark holidays "free" (TRANSPARENT); there, every event blocks its day.
    return st === "CANCELLED" || (tr === "TRANSPARENT" && !o.ignoreTransp);
  };

  for (const { uid, e } of masters) {
    const start = parseDt(e.DTSTART.value, e.DTSTART.params);
    if (!start) continue;
    if (start.date && o.allDay === "ignore") continue;
    const zone = zoneFor(start.tzid);
    const startMs = toUtc(start, zone);
    let durMs = 0;
    let durDays = start.date ? 1 : 0;
    if (e.DTEND) {
      const endDt = parseDt(e.DTEND.value, e.DTEND.params);
      if (endDt) {
        if (start.date) durDays = Math.max(1, dayNum(endDt.y, endDt.mo, endDt.d) - dayNum(start.y, start.mo, start.d));
        else durMs = toUtc(endDt, zoneFor(endDt.tzid ?? start.tzid), "later") - startMs;
      }
    } else if (e.DURATION) {
      const d = parseDuration(e.DURATION.value);
      if (d) {
        if (start.date && !d.timed) durDays = Math.max(1, d.days);
        else durMs = d.ms;
      }
    }
    const span = (sMs, dt) => {
      if (dt.date) {
        const dateStr = `${dt.y}-${p2(dt.mo)}-${p2(dt.d)}`;
        const s = startOfDay(ownerZone, dateStr);
        const endD = fromDay(dayNum(dt.y, dt.mo, dt.d) + durDays);
        return [s, startOfDay(ownerZone, `${endD.y}-${p2(endD.mo)}-${p2(endD.d)}`)];
      }
      return [sMs, sMs + durMs];
    };

    // Overrides of this series: their RECURRENCE-ID instants replace instances.
    const replaced = new Set();
    for (const ov of overrides.get(uid) ?? []) {
      const rid = parseDt(ov["RECURRENCE-ID"].value, ov["RECURRENCE-ID"].params);
      if (rid) replaced.add(rid.date ? `d${rid.y}${p2(rid.mo)}${p2(rid.d)}` : toUtc(rid, zoneFor(rid.tzid ?? start.tzid)));
    }
    const excluded = new Set();
    for (const ex of e.exdate) {
      for (const v of ex.value.split(",")) {
        const dt = parseDt(v, ex.params);
        if (dt) excluded.add(dt.date ? `d${dt.y}${p2(dt.mo)}${p2(dt.d)}` : toUtc(dt, zoneFor(dt.tzid ?? start.tzid)));
      }
    }
    const keyOf = (dt, ms) => (dt.date ? `d${dt.y}${p2(dt.mo)}${p2(dt.d)}` : ms);
    const free = isFree(e);
    const emit = (dt, ms) => {
      const k = keyOf(dt, ms);
      const dk = `d${dt.y}${p2(dt.mo)}${p2(dt.d)}`; // an EXDATE given as a date also removes a timed instance that day
      if (free || excluded.has(k) || replaced.has(k) || excluded.has(dk)) return;
      const [s, en] = span(ms, dt);
      add(s, en);
    };

    if (!e.RRULE) {
      emit(start, startMs);
    } else {
      const r = parseRule(e.RRULE.value);
      const dur = start.date ? durDays * DAY : Math.max(durMs, 0);
      const winDay = Math.floor((now - dur) / DAY) - 2;
      const stopDay = Math.floor(until / DAY) + 2;
      let isPastUntil = () => false;
      if (r.until) {
        if (r.until.utc && !start.date) {
          isPastUntil = (d) => {
            const w = fromDay(d);
            return toUtc({ ...start, y: w.y, mo: w.mo, d: w.d }, zone) > Date.UTC(r.until.y, r.until.mo - 1, r.until.d, r.until.h, r.until.mi, r.until.s);
          };
        } else {
          const uDay = dayNum(r.until.y, r.until.mo, r.until.d);
          const uSec = r.until.date ? 86399 : r.until.h * 3600 + r.until.mi * 60 + r.until.s;
          const sSec = start.h * 3600 + start.mi * 60 + start.s;
          isPastUntil = (d) => d > uDay || (d === uDay && sSec > uSec);
        }
      }
      const res = r.unsupported ? null : expandDays(r, start, stopDay, winDay, isPastUntil);
      if (!res || res.capped) {
        overBlock(e.RRULE.value, r.unsupported ?? `more than ${MAX_ITERATIONS} repeats before now`, start, zone, startMs, start.date ? durDays * DAY : durMs, isPastUntil);
      } else {
        for (const d of res.days) {
          const w = fromDay(d);
          const dt = { ...start, y: w.y, mo: w.mo, d: w.d };
          emit(dt, start.date ? 0 : toUtc(dt, zone));
        }
      }
    }
    for (const rd of e.rdate) {
      for (const v of rd.value.split(",")) {
        const [a, b] = v.split("/");
        const dt = parseDt(a, rd.params);
        if (!dt) continue;
        const ms = toUtc(dt, zoneFor(dt.tzid ?? start.tzid));
        if (b) {
          // PERIOD: start/end or start/duration
          const endDt = parseDt(b, rd.params);
          const d = endDt ? null : parseDuration(b);
          const endMs = endDt ? toUtc(endDt, zoneFor(endDt.tzid ?? start.tzid), "later") : d ? ms + d.ms : ms + durMs;
          if (!free && !excluded.has(ms) && !replaced.has(ms)) add(ms, endMs);
        } else emit(dt, ms);
      }
    }
  }

  // Overrides stand on their own (also those whose series we never saw).
  for (const list of overrides.values()) {
    for (const e of list) {
      if (isFree(e)) continue;
      const start = parseDt(e.DTSTART.value, e.DTSTART.params);
      if (!start || (start.date && o.allDay === "ignore")) continue;
      const s = toUtc(start, zoneFor(start.tzid));
      let en = s;
      if (e.DTEND) {
        const endDt = parseDt(e.DTEND.value, e.DTEND.params);
        if (endDt) en = toUtc(endDt, zoneFor(endDt.tzid ?? start.tzid), "later");
      } else if (e.DURATION) {
        const d = parseDuration(e.DURATION.value);
        if (d) en = s + d.ms;
      } else if (start.date) en = s + DAY;
      add(s, en);
    }
  }

  // A rule we can't expand exactly (HOURLY, BYHOUR lists, BYWEEKNO...) could
  // put an instance at any time of day, so it blocks whole days (your zone)
  // from its start to the horizon, or to UNTIL if that's readable: too much,
  // never too little.
  function overBlock(rule, reason, start, zone, startMs, durMs, isPastUntil) {
    if (stats.unsupported.length < 50) stats.unsupported.push({ rule: String(rule).slice(0, 200), reason, treatedAs: "busy all day, every day, from its start to the horizon or UNTIL" });
    const from = Math.max(dayNum(start.y, start.mo, start.d), Math.floor(now / DAY) - 1);
    const to = Math.floor(until / DAY) + 1;
    for (let d = from; d <= to; d++) {
      if (isPastUntil(d)) break;
      const w = fromDay(d);
      const n2 = fromDay(d + 1);
      add(startOfDay(ownerZone, `${w.y}-${p2(w.mo)}-${p2(w.d)}`), startOfDay(ownerZone, `${n2.y}-${p2(n2.mo)}-${p2(n2.d)}`));
    }
  }

  return { intervals: mergeIntervals(busy), stats };
}

/** Sorts and merges [start, end] pairs. */
export function mergeIntervals(list) {
  const a = list.filter((x) => x[1] > x[0]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const x of a) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

/** Wall time -> UTC by a feed's own VTIMEZONE (STANDARD / DAYLIGHT onsets). */
function vtzToUtc(tz, dt) {
  const wall = Date.UTC(dt.y, dt.mo - 1, dt.d, dt.h, dt.mi, dt.s);
  let best = null;
  let earliest = null;
  for (const s of tz.subs) {
    const to = parseOffset(s.TZOFFSETTO);
    const from = parseOffset(s.TZOFFSETFROM) ?? to;
    if (to === null || !s.DTSTART) continue;
    const st = parseDt(s.DTSTART);
    if (!st) continue;
    const onsets = [];
    const rule = s.RRULE ? parseRule(s.RRULE) : null;
    if (rule && !rule.unsupported && rule.freq === "YEARLY") {
      for (const y of [dt.y - 1, dt.y]) {
        if (y < st.y) continue;
        const months = rule.bymonth ?? [st.mo];
        for (const mo of months) {
          let d = null;
          if (rule.byday?.length) d = nthInMonth(y, mo, rule.byday[0].wd, rule.byday[0].n || 1);
          else if (rule.bymonthday?.length) d = dayNum(y, mo, Math.min(rule.bymonthday[0], daysIn(y, mo)));
          else d = dayNum(y, mo, Math.min(st.d, daysIn(y, mo)));
          if (d !== null) onsets.push(d * DAY + (st.h * 3600 + st.mi * 60 + st.s) * 1000);
        }
      }
    } else onsets.push(Date.UTC(st.y, st.mo - 1, st.d, st.h, st.mi, st.s));
    for (const on of onsets) {
      if (on <= wall && (!best || on > best.on)) best = { on, to };
      if (!earliest || on < earliest.on) earliest = { on, from };
    }
  }
  const off = best ? best.to : earliest ? earliest.from : 0;
  return wall - off;
}

function parseOffset(s) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(s ?? "").trim());
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * ((+m[2] * 60 + +m[3]) * 60 + +(m[4] ?? 0)) * 1000;
}

function p2(n) {
  return String(n).padStart(2, "0");
}

function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}
