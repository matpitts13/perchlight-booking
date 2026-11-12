// Housekeeping, with no cron trigger (docs/SDD.md, "Reminders and housekeeping without cron").
//
// Two ways in, one code path:
//   1. The Clock Durable Object's alarm, set for the next due time (a hold or
//      request expiring, a reminder, a retry). It runs without the throttle.
//   2. Lazily, as perchlight-forms: after public and admin requests and
//      GET /tick, at most every HOUSEKEEPING_MINUTES (one conditional UPDATE
//      on the state table decides), if the request's budget has room. If the
//      Clock were unavailable, reminders would be late until someone visits,
//      never lost (and never sent after the meeting started).
//
// Each run, within the subrequest budget (src/lib/budget.js):
//   a. releases stale send claims and expires holds and requests (one batch);
//   b. carries out what the desktop app asked for (cancel / approve / decline);
//   c. hourly: retention (personal details removed RETENTION_DAYS after the
//      meeting), old cells, counters and delivery rows, and recounts days;
//   d. sends due notifications with what's left.
import { releaseStaleStatements, deliverDue, STALE_MS } from "./deliveries.js";
import { expireStatements, cancel, approve, loadBooking, ACTIVE_B } from "./bookings.js";
import { settings } from "./settings.js";
import { sqlTime, utcDay } from "./http.js";
import { localDate } from "./tz.js";
import { spend, left, COST, MIN_UNIT } from "./budget.js";

export const DELIVERIES_PER_RUN = 5;
export const RETENTION_BATCH = 40;
const APP_REQUESTS_PER_RUN = 3;
const RETENTION_EVERY_MS = 3600_000;
const LOCAL_THROTTLE_MS = 15_000;
const DAY = 86_400_000;

let lastLocal = 0;
/** Tests only. */
export function resetLocalThrottle() {
  lastLocal = 0;
}

/** Starts a lazy run after the reply, if one is due. Never throws. */
export function maybeHousekeep(app, ctx, now = app.now()) {
  if (now - lastLocal < LOCAL_THROTTLE_MS) return;
  if (left(app.budget) < COST.housekeepingBase + MIN_UNIT) return;
  lastLocal = now;
  ctx.waitUntil(
    runHousekeeping(app, { now })
      // Only new work (a retry after a failed send, an app request) needs the Clock moved earlier.
      .then((r) => (r.ran && (r.deliveries?.tried > 0 || r.appRequests > 0) ? scheduleNext(app) : null))
      .catch((err) => console.error(`housekeeping: ${err instanceof Error ? err.stack : String(err)}`)),
  );
}

async function claimSlot(env, intervalMs, now) {
  const r = await env.DB.prepare("UPDATE state SET value = ?1 WHERE key = 'last_run' AND CAST(value AS INTEGER) <= ?2")
    .bind(String(now), now - intervalMs)
    .run();
  return r.meta.changes === 1;
}

async function guarded(what, fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    console.error(`housekeeping, ${what}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

/**
 * One run. force: ignore the throttle and run retention now (POST /api/housekeeping).
 * fromAlarm: the Clock woke us (no throttle; retention only if due).
 */
export async function runHousekeeping(app, { now = app.now(), force = false, fromAlarm = false } = {}) {
  const { env } = app;
  const s = settings(env);
  if (left(app.budget) < COST.housekeepingBase + MIN_UNIT) return { ran: false, budget: true };
  spend(app.budget, COST.housekeepingBase);
  if (force || fromAlarm) {
    await env.DB.prepare("UPDATE state SET value = ?1 WHERE key = 'last_run'").bind(String(now)).run();
  } else if (!(await claimSlot(env, s.housekeepingMinutes * 60_000, now))) {
    return { ran: false };
  }
  const result = { ran: true, appRequests: 0, retention: null, deliveries: null };
  try {
    await env.DB.batch([...releaseStaleStatements(env.DB, now), ...expireStatements(env.DB, now, app.cfg.visitorEmail)]);
    const state = Object.fromEntries(
      (await env.DB.prepare("SELECT key, value FROM state WHERE key IN ('last_retention', 'retention_errors')").all()).results.map((r) => [r.key, r.value]),
    );
    result.appRequests = await guarded("desktop app requests", () => appRequests(app, now), 0);
    const keep = COST.deliverySelect + COST.delivery;
    if ((force || now - (Number(state.last_retention) || 0) >= RETENTION_EVERY_MS) && left(app.budget) - keep >= COST.retention + COST.stateSave) {
      spend(app.budget, COST.retention + COST.stateSave);
      result.retention = await guarded("retention", () => retention(app, now), { error: true });
      await guarded("saving retention progress", () =>
        env.DB.batch([
          env.DB.prepare("UPDATE state SET value = ?1 WHERE key = 'last_retention'").bind(String(result.retention?.more ? now - RETENTION_EVERY_MS + 60_000 : now)),
          env.DB.prepare("UPDATE state SET value = ?1 WHERE key = 'retention_errors'").bind(
            JSON.stringify(result.retention?.error ? { retention: { at: new Date(now).toISOString() } } : {}),
          ),
        ]),
      );
    }
  } finally {
    result.deliveries = await guarded("deliveries", () => deliverDue(app, DELIVERIES_PER_RUN, now), { tried: 0, sent: 0 });
  }
  return result;
}

/**
 * The Perchlight desktop app writes D1 directly and can't run a transaction,
 * so its buttons set cancel_requested / approve_requested / decline_requested;
 * the real change (cells, counts, emails) happens here.
 */
async function appRequests(app, now) {
  const { env } = app;
  const { results } = await env.DB.prepare(
    `SELECT id FROM bookings WHERE status IN ('cancel_requested', 'approve_requested', 'decline_requested') ORDER BY start_ms LIMIT ?1`,
  ).bind(APP_REQUESTS_PER_RUN).all();
  let done = 0;
  for (const { id } of results) {
    if (!spend(app.budget, COST.appRequest + COST.change)) break;
    const b = await loadBooking(env, id);
    if (!b) continue;
    let r;
    if (b.status === "cancel_requested") r = await cancel(app, b, { by: "owner", reason: "cancelled in the Perchlight app", now });
    else if (b.status === "decline_requested") r = await cancel(app, b, { by: "owner", reason: "declined in the Perchlight app", now, kind: "declined" });
    else r = await approve(app, b, { now });
    if (r.ok) done++;
    else {
      // Its time was already released (or it's past): put the status back to what really happened.
      await env.DB.prepare(
        `UPDATE bookings SET status = CASE status WHEN 'cancel_requested' THEN 'cancelled' WHEN 'decline_requested' THEN 'declined' ELSE 'expired' END,
           cancel_reason = COALESCE(cancel_reason, 'the app asked after its time was released')
         WHERE id = ?1 AND status IN ('cancel_requested', 'approve_requested', 'decline_requested')
           AND (NOT EXISTS (SELECT 1 FROM slot_cells WHERE booking_id = ?1) OR start_ms <= ?2)`,
      ).bind(id, now).run();
    }
  }
  return done;
}

/**
 * Personal details are removed RETENTION_DAYS after the meeting (the row
 * stays as an anonymous "booking happened" record), or the row is deleted
 * with "retentionMode": "delete". Plus old cells, counters and delivery rows,
 * and a recount of upcoming days (in case the desktop app deleted a row).
 */
async function retention(app, now) {
  const { env, cfg } = app;
  const days = settings(env).retentionDays;
  const out = { anonymised: 0, deleted: 0, more: false };
  const stmts = [];
  if (days > 0) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM bookings WHERE end_ms < ?1 AND (anonymised_at IS NULL OR ?3 = 1)
         AND status IN ('confirmed', 'cancelled', 'declined', 'expired') ORDER BY end_ms LIMIT ?2`,
    ).bind(now - days * DAY, RETENTION_BATCH, cfg.retentionMode === "delete" ? 1 : 0).all();
    const ids = results.map((r) => r.id);
    out.more = ids.length === RETENTION_BATCH;
    if (ids.length) {
      const marks = (from) => ids.map((_, i) => `?${i + from}`).join(", ");
      stmts.push(env.DB.prepare(`DELETE FROM deliveries WHERE booking_id IN (${marks(1)})`).bind(...ids));
      if (cfg.retentionMode === "delete") {
        stmts.push(env.DB.prepare(`DELETE FROM bookings WHERE id IN (${marks(1)})`).bind(...ids));
        out.deleted = ids.length;
      } else {
        stmts.push(env.DB.prepare(`UPDATE bookings SET ${ANONYMISE}, anonymised_at = ?1 WHERE id IN (${marks(2)})`).bind(sqlTime(now), ...ids));
        out.anonymised = ids.length;
      }
    }
  }
  const today = localDate(cfg.owner.timeZone, now);
  stmts.push(
    env.DB.prepare("DELETE FROM slot_cells WHERE cell_ms IN (SELECT cell_ms FROM slot_cells WHERE cell_ms < ?1 LIMIT 2000)").bind(now - DAY),
    env.DB.prepare("DELETE FROM day_counts WHERE local_day < ?1").bind(localDate(cfg.owner.timeZone, now - 2 * DAY)),
    env.DB.prepare("DELETE FROM rate_counters WHERE rowid IN (SELECT rowid FROM rate_counters WHERE hour < ?1 LIMIT 1000)").bind(new Date(now - 48 * 3600_000).toISOString().slice(0, 13)),
    env.DB.prepare("DELETE FROM email_counts WHERE day < ?1").bind(utcDay(now - 2 * DAY)),
    env.DB.prepare("DELETE FROM daily_counts WHERE day < ?1").bind(utcDay(now - 400 * DAY)),
    env.DB.prepare(
      `DELETE FROM deliveries WHERE rowid IN (SELECT rowid FROM deliveries
         WHERE created_ms < ?1 AND status IN ('sent', 'failed', 'unknown', 'skipped') LIMIT 1000)`,
    ).bind(now - 90 * DAY),
    // Recount upcoming days; only rows that are wrong are written.
    env.DB.prepare(
      `UPDATE day_counts SET n = MIN(cap, (SELECT COUNT(*) FROM bookings b WHERE b.local_day = day_counts.local_day
          AND (day_counts.type_id = '*' OR b.type_id = day_counts.type_id) AND ${ACTIVE_B}))
       WHERE local_day >= ?2 AND n != MIN(cap, (SELECT COUNT(*) FROM bookings b WHERE b.local_day = day_counts.local_day
          AND (day_counts.type_id = '*' OR b.type_id = day_counts.type_id) AND ${ACTIVE_B}))`,
    ).bind(now, today),
  );
  await env.DB.batch(stmts);
  return out;
}

/** The personal fields a removal clears. */
export const ANONYMISE = "name = NULL, email = NULL, phone = NULL, notes = NULL, location_detail = NULL, visitor_tz = NULL, cancel_reason = NULL, hold_token_hash = NULL, net_hash = NULL";

/** The next time anything is due (for the Clock's alarm), or null. */
export async function nextDue(env) {
  const row = await env.DB.prepare(
    `SELECT MIN(t) AS t FROM (
       SELECT MIN(next_attempt_at) AS t FROM deliveries WHERE status IN ('pending', 'retry')
       UNION ALL SELECT MIN(claimed_at) + ${STALE_MS + 1000} FROM deliveries WHERE status = 'sending'
       UNION ALL SELECT MIN(hold_expires_at) FROM bookings WHERE status = 'held'
       UNION ALL SELECT MIN(request_expires_at) FROM bookings WHERE status = 'requested')`,
  ).first();
  return row?.t ?? null;
}

/** Asks the Clock to wake at `at` (it keeps whichever alarm is earlier). Never throws. */
export async function wakeClock(app, at) {
  if (at === null || at === undefined || !app.env.CLOCK) return null;
  if (!spend(app.budget, COST.clock)) return null;
  try {
    const stub = app.env.CLOCK.get(app.env.CLOCK.idFromName("clock"));
    return await stub.wake(at, app.base);
  } catch (err) {
    // The lazy runs still catch everything; only timing suffers.
    console.error(`clock: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** After a change: arm the Clock for whatever is now due next. */
export async function scheduleNext(app) {
  if (!spend(app.budget, 1)) return null;
  const at = await guarded("next due", () => nextDue(app.env));
  return at === null ? null : wakeClock(app, at);
}
