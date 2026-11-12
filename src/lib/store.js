// Reads for slot listing: exceptions, claimed cells and day counts for a
// window, in one D1 batch (one subrequest).
import { ACTIVE_B } from "./bookings.js";
import { localDate, addDays } from "./tz.js";

const DAY = 86_400_000;

export function parseRangesJson(s) {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.filter((r) => Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[1] > r[0]) : [];
  } catch {
    return [];
  }
}

/** Everything freeSlots needs besides busy times, for [fromMs, toMs). */
export async function windowData(app, fromMs, toMs, now) {
  const zone = app.cfg.owner.timeZone;
  const fromDay = addDays(localDate(zone, fromMs), -1);
  const toDay = addDays(localDate(zone, toMs), 1);
  const db = app.env.DB;
  const [ex, cells, counts] = await db.batch([
    db.prepare("SELECT date, kind, ranges FROM exceptions WHERE date >= ?1 AND date <= ?2").bind(fromDay, toDay),
    // Cells of expired holds and requests don't count: they're free already.
    db.prepare(
      `SELECT c.cell_ms FROM slot_cells c JOIN bookings b ON b.id = c.booking_id
       WHERE c.cell_ms >= ?2 AND c.cell_ms < ?3 AND ${ACTIVE_B}`,
    ).bind(now, fromMs - DAY, toMs + DAY),
    db.prepare(
      `SELECT b.local_day, b.type_id, COUNT(*) AS n FROM bookings b
       WHERE b.local_day >= ?2 AND b.local_day <= ?3 AND ${ACTIVE_B} GROUP BY b.local_day, b.type_id`,
    ).bind(now, fromDay, toDay),
  ]);
  const exceptions = new Map(ex.results.map((r) => [r.date, { kind: r.kind, ranges: parseRangesJson(r.ranges) }]));
  const countMap = new Map();
  for (const r of counts.results) {
    countMap.set(`${r.local_day}|${r.type_id}`, r.n);
    countMap.set(`${r.local_day}|*`, (countMap.get(`${r.local_day}|*`) ?? 0) + r.n);
  }
  return { exceptions, cells: new Set(cells.results.map((r) => r.cell_ms)), counts: countMap };
}
