// Which start times are free.
//
// Slots are generated per local day in the owner's zone: that weekday's
// ranges (narrowed by the event type), replaced by the date's exception if
// there is one, nothing on holidays; each range's local start and end are
// converted to UTC (start: the earlier instant if ambiguous, end: the later;
// an edge inside a spring-forward gap moves to the first valid instant), and
// slot starts step from the range start by stepMinutes. Then minimum
// notice, horizon, daily caps (owner's days), your calendar's busy times
// (padded by the buffer on both sides) and the cells already claimed.
import { wallToUtc, startOfDay, localDate, addDays, weekday, parseDate } from "./tz.js";
import { intersectRanges } from "./config.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Local [startMinute, endMinute] ranges of one date for a type. */
export function dayRanges(cfg, type, date, exceptions = new Map()) {
  if (cfg.owner.holidays.has(date)) return [];
  const wd = weekday(date);
  const ex = exceptions.get(date);
  if (!ex) return type.weekly[wd] ?? [];
  if (ex.kind === "off") return [];
  const ranges = Array.isArray(ex.ranges) ? ex.ranges : [];
  return type.ownWeekly ? intersectRanges(ranges, type.ownWeekly[wd] ?? []) : ranges;
}

/** A local minute-of-day on a date -> UTC ms. edge: "start" | "end". */
export function localToUtc(zone, date, minute, edge) {
  if (minute >= 1440) return startOfDay(zone, addDays(date, 1));
  const p = parseDate(date);
  return wallToUtc(zone, p.y, p.mo, p.d, Math.floor(minute / 60), minute % 60, 0, edge === "end" ? "later" : "earlier");
}

/** Every slot start a date offers by the rules alone (no notice, busy or caps). */
export function dayStarts(cfg, type, date, exceptions) {
  const zone = cfg.owner.timeZone;
  const out = [];
  const len = type.minutes * MIN;
  const cell = type.cell * MIN;
  for (const [a, b] of dayRanges(cfg, type, date, exceptions)) {
    const s = localToUtc(zone, date, a, "start");
    const e = localToUtc(zone, date, b, "end");
    for (let t = Math.ceil(s / cell) * cell; t + len <= e; t += type.step * MIN) out.push(t);
  }
  return out;
}

/** The cells a booking claims: start to end plus its buffer after. */
export function cellsFor(type, startMs, minutes = type.minutes) {
  const cell = type.cell * MIN;
  const out = [];
  for (let t = startMs; t < startMs + (minutes + type.bufferAfter) * MIN; t += cell) out.push(t);
  return out;
}

/** Does [s, e) (minutes) touch any merged busy interval? Binary search. */
export function overlapsBusy(busy, s, e) {
  let lo = 0;
  let hi = busy.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (busy[mid][1] <= s) lo = mid + 1;
    else if (busy[mid][0] >= e) hi = mid - 1;
    else return true;
  }
  return false;
}

/** Why a start can't be held by the rules (not busy / caps), or null. */
export function ruleProblem(cfg, type, startMs, now, exceptions) {
  if (!Number.isFinite(startMs) || startMs % (type.cell * MIN)) return "That isn't one of the offered times.";
  if (startMs < now + type.minNoticeHours * HOUR) return `Times need at least ${type.minNoticeHours} hours' notice.`;
  if (startMs > now + type.horizonDays * DAY) return `Times can be booked at most ${type.horizonDays} days ahead.`;
  const date = localDate(cfg.owner.timeZone, startMs);
  // A slot near midnight belongs to the day its range was defined on.
  for (const d of [date, addDays(date, -1)]) if (dayStarts(cfg, type, d, exceptions).includes(startMs)) return null;
  return "That isn't one of the offered times.";
}

/**
 * Free slot starts in [fromMs, toMs).
 * @param {{ fromMs: number, toMs: number, now: number, exceptions: Map, busy: number[][], cells: Set<number>, counts: Map<string, number> }} o
 *   busy: merged minute intervals; cells: claimed cell instants; counts: "day|typeId" and "day|*" -> active bookings
 */
export function freeSlots(cfg, type, o) {
  const zone = cfg.owner.timeZone;
  const earliest = Math.max(o.fromMs, o.now + type.minNoticeHours * HOUR);
  const latest = Math.min(o.toMs, o.now + type.horizonDays * DAY + 1);
  if (earliest >= latest) return [];
  const out = [];
  const pad = type.bufferAfter;
  let date = addDays(localDate(zone, earliest), -1);
  const lastDate = localDate(zone, latest);
  for (let guard = 0; date <= lastDate && guard < 400; guard++, date = addDays(date, 1)) {
    const capType = type.dailyCap;
    const capAll = cfg.owner.dailyCap;
    if (capType !== null && (o.counts.get(`${date}|${type.id}`) ?? 0) >= capType) continue;
    if (capAll !== null && (o.counts.get(`${date}|*`) ?? 0) >= capAll) continue;
    for (const t of dayStarts(cfg, type, date, o.exceptions)) {
      if (t < earliest || t >= latest) continue;
      const sMin = t / MIN;
      if (overlapsBusy(o.busy, sMin - pad, sMin + type.minutes + pad)) continue;
      if (cellsFor(type, t).some((c) => o.cells.has(c))) continue;
      out.push(t);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** The free times nearest to a wanted start (for "that time was just taken"). */
export function nearest(cfg, type, startMs, o, n = 3) {
  const all = freeSlots(cfg, type, { ...o, fromMs: startMs - 3 * DAY, toMs: startMs + 4 * DAY }).filter((t) => t !== startMs);
  return all
    .sort((a, b) => Math.abs(a - startMs) - Math.abs(b - startMs) || a - b)
    .slice(0, n)
    .sort((a, b) => a - b);
}
