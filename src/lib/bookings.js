// Holding, confirming, moving and cancelling bookings (docs/adr/0001-slot-cells-guarded-batches.md):
// each change is ONE
// D1 batch (a single transaction), so it either all happens or none of it.
//
// No double booking: a hold or booking claims every cell from its start to
// its end plus its buffer after; slot_cells.cell_ms is the primary key, so a
// second claim on any of those cells makes the whole batch roll back.
// Daily caps: day_counts rows carry their cap and CHECK (n <= cap).
//
// Guarded batches: the first statement of a change marks the booking with a
// fresh nonce (op) only if it's still in the state the change expects (for
// example "held, not expired, this token"); every later statement in the
// batch runs only WHERE EXISTS that nonce. If the booking moved on meanwhile
// (another tab, the desktop app, an expiry), nothing in the batch does anything
// and the caller is told, instead of half a change.
//
// Expired holds and requests never block anyone: every claiming batch first
// expires them (releasing their cells and counts) in the same transaction.
import { randomId, sha256Hex } from "./crypto.js";
import { sqlTime } from "./http.js";
import { localDate } from "./tz.js";
import { cellsFor } from "./slots.js";

const MIN = 60_000;
const HOUR = 3_600_000;
export const NO_CAP = 1_000_000;
export const VERIFY_MINUTES = 30;

const EXPIRED = (a = "") =>
  `((${a}status = 'held' AND ${a}hold_expires_at <= ?1) OR (${a}status = 'requested' AND ${a}request_expires_at <= ?1))`;
/** Bookings that hold their time (SQL, alias b, now = ?1). */
export const ACTIVE_B = `(b.status IN ('confirmed', 'cancel_requested', 'approve_requested', 'decline_requested')
  OR (b.status = 'held' AND b.hold_expires_at > ?1) OR (b.status = 'requested' AND b.request_expires_at > ?1))`;
const LIVE = ["confirmed", "requested", "cancel_requested", "approve_requested", "decline_requested"];
const inList = (l) => l.map((s) => `'${s}'`).join(", ");

function randomHex(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Expires holds and requests whose time ran out: counts, cells, notices, status. */
export function expireStatements(db, now) {
  return [
    db.prepare(
      `UPDATE day_counts SET n = MAX(0, n - (SELECT COUNT(*) FROM bookings b WHERE b.local_day = day_counts.local_day
         AND (day_counts.type_id = '*' OR b.type_id = day_counts.type_id) AND ${EXPIRED("b.")}))
       WHERE local_day IN (SELECT local_day FROM bookings WHERE ${EXPIRED()})
         AND (type_id = '*' OR type_id IN (SELECT type_id FROM bookings WHERE ${EXPIRED()}))`,
    ).bind(now),
    db.prepare(`DELETE FROM slot_cells WHERE booking_id IN (SELECT id FROM bookings WHERE ${EXPIRED()})`).bind(now),
    db.prepare(
      `INSERT OR IGNORE INTO deliveries (id, booking_id, kind, sequence, due_ms, next_attempt_at, created_ms)
       SELECT 'dl_' || lower(hex(randomblob(8))), b.id, k.kind, b.sequence + 1, ?1, ?1, ?1
       FROM bookings b, (SELECT 'owner_expired' AS kind UNION ALL SELECT 'visitor_cancel') k
       WHERE b.status = 'requested' AND b.request_expires_at <= ?1`,
    ).bind(now),
    db.prepare(
      `UPDATE bookings SET
         sequence = sequence + CASE WHEN status = 'requested' THEN 1 ELSE 0 END,
         cancelled_by = 'system', cancelled_at = ?2,
         cancel_reason = CASE WHEN status = 'requested' THEN 'the request wasn''t approved in time' ELSE 'the hold ran out' END,
         status = 'expired', hold_token_hash = NULL, net_hash = NULL
       WHERE ${EXPIRED()}`,
    ).bind(now, sqlTime(now)),
  ];
}

const guard = "EXISTS (SELECT 1 FROM bookings WHERE id = ?1 AND op = ?2)";

function countUp(db, id, nonce, day, typeId, cap) {
  return db.prepare(
    `INSERT INTO day_counts (local_day, type_id, n, cap) SELECT ?3, ?4, 1, ?5 WHERE ${guard}
     ON CONFLICT (local_day, type_id) DO UPDATE SET n = n + 1, cap = excluded.cap`,
  ).bind(id, nonce, day, typeId, cap ?? NO_CAP);
}

function countDown(db, id, nonce, day, typeId) {
  return db.prepare(`UPDATE day_counts SET n = MAX(0, n - 1) WHERE local_day = ?3 AND type_id = ?4 AND ${guard}`).bind(id, nonce, day, typeId);
}

function claimCells(db, id, nonce, cells) {
  return db.prepare(`INSERT INTO slot_cells (cell_ms, booking_id) SELECT value, ?1 FROM json_each(?3) WHERE ${guard}`).bind(id, nonce, JSON.stringify(cells));
}

function releaseCells(db, id, nonce) {
  return db.prepare(`DELETE FROM slot_cells WHERE booking_id = ?1 AND ${guard}`).bind(id, nonce);
}

function deliveryStmt(db, id, nonce, { kind, sequence, due }, now) {
  return db.prepare(
    `INSERT OR IGNORE INTO deliveries (id, booking_id, kind, sequence, due_ms, next_attempt_at, created_ms)
     SELECT ?3, ?1, ?4, ?5, ?6, ?6, ?7 WHERE ${guard}`,
  ).bind(id, nonce, randomId("dl"), kind, sequence, due, now);
}

function skipReminders(db, id, nonce, why) {
  return db.prepare(
    `UPDATE deliveries SET status = 'skipped', last_error = ?3
     WHERE booking_id = ?1 AND kind LIKE 'reminder_%' AND status IN ('pending', 'retry') AND ${guard}`,
  ).bind(id, nonce, why);
}

/** Whether visitor emails go out for this booking. */
export function visitorEmailsOn(cfg, b) {
  return cfg.visitorEmail !== "none" && (b.turnstile === "passed" || b.via === "owner");
}

/**
 * The notifications an event creates.
 * event: confirmed | requested | verify | changed | cancelled | declined
 */
export function deliveryPlan(cfg, type, b, event, sequence, now) {
  const v = visitorEmailsOn(cfg, b);
  const out = [];
  const add = (kind, due = now) => out.push({ kind, sequence, due });
  const reminders = () => {
    for (const m of type?.reminders ?? []) {
      const due = b.start_ms - m * MIN;
      if (due <= now) continue; // a reminder that would already be due isn't created
      add(`reminder_owner_${m}`, due);
      if (v) add(`reminder_visitor_${m}`, due);
    }
  };
  if (event === "confirmed") {
    add("owner_new");
    if (v) add("visitor_confirm");
    reminders();
  } else if (event === "requested") {
    add("owner_request");
    if (v) add("visitor_request");
  } else if (event === "verify") {
    add("visitor_verify");
  } else if (event === "changed") {
    add("owner_change");
    if (v) add("visitor_change");
    if (b.status === "confirmed") reminders();
  } else if (event === "cancelled") {
    add("owner_cancel");
    if (v) add("visitor_cancel");
  } else if (event === "declined") {
    if (v) add("visitor_cancel");
  }
  return out;
}

/** Turns a D1 error into what the visitor should be told. */
export function classifyError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed: slot_cells/i.test(msg)) return "taken";
  if (/CHECK constraint failed/i.test(msg)) return "full";
  console.error(`D1: ${msg}`);
  return "db";
}

/**
 * Holds a start time. Nothing is written unless all of it is.
 * @returns {Promise<{ ok: true, id: string, token: string, expiresAt: number }
 *   | { ok: false, error: "taken" | "full" | "busy" | "network" | "db" }>}
 */
export async function hold(app, { type, startMs, now, netHash = null, turnstile = "off", via = "page", maxActive, maxPerNetwork }) {
  const { env, cfg } = app;
  const db = env.DB;
  const id = randomId("bk");
  const token = randomHex(16);
  const nonce = randomHex(8);
  const day = localDate(cfg.owner.timeZone, startMs);
  const end = startMs + type.minutes * MIN;
  const expires = now + type.holdMinutes * MIN;
  const stmts = [
    ...expireStatements(db, now),
    db.prepare(
      `INSERT INTO bookings (id, type_id, start_ms, end_ms, claim_end_ms, local_day, start_at, status, hold_expires_at,
         hold_token_hash, net_hash, turnstile, via, created_at, created_ms, op)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'held', ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
       WHERE (SELECT COUNT(*) FROM bookings WHERE status = 'held' AND hold_expires_at > ?14) < ?16
         AND (?10 IS NULL OR (SELECT COUNT(*) FROM bookings WHERE status = 'held' AND hold_expires_at > ?14 AND net_hash = ?10) < ?17)`,
    ).bind(
      id, type.id, startMs, end, end + type.bufferAfter * MIN, day, sqlTime(startMs), expires,
      await sha256Hex(token), netHash, turnstile, via, sqlTime(now), now, nonce,
      maxActive ?? NO_CAP, maxPerNetwork ?? NO_CAP,
    ),
    claimCells(db, id, nonce, cellsFor(type, startMs)),
    countUp(db, id, nonce, day, type.id, type.dailyCap),
    countUp(db, id, nonce, day, "*", cfg.owner.dailyCap),
  ];
  let results;
  try {
    results = await db.batch(stmts);
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  }
  if (results[4].meta.changes !== 1) {
    // Refused by the "holds at once" caps: which one?
    if (netHash) {
      const r = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'held' AND hold_expires_at > ?1 AND net_hash = ?2").bind(now, netHash).first();
      if ((r?.n ?? 0) >= (maxPerNetwork ?? NO_CAP)) return { ok: false, error: "network" };
    }
    return { ok: false, error: "busy" };
  }
  return { ok: true, id, token, expiresAt: expires };
}

/**
 * Turns a hold into a booking (or a request, or "check your email").
 * @returns {Promise<{ ok: true, status: string, booking: object } | { ok: false, error: "expired" | "token" | "used" | "gone" | "db" }>}
 */
export async function confirm(app, { id, token, details, type, now, verify = false }) {
  const { env, cfg } = app;
  const db = env.DB;
  const nonce = randomHex(8);
  const b = await loadBooking(env, id);
  if (!b) return { ok: false, error: "gone" };
  const tokenHash = await sha256Hex(String(token ?? ""));
  const status = verify ? "held" : type.approval ? "requested" : "confirmed";
  const requestExpires = status === "requested" ? Math.min(now + type.requestHours * HOUR, b.start_ms) : null;
  const loc = cfg.locations[details.location];
  const locationDetail = loc ? defaultLocationDetail(loc, details) : "";
  const next = { ...b, ...details, status, request_expires_at: requestExpires };
  const plan = deliveryPlan(cfg, type, next, verify ? "verify" : status, b.sequence, now);
  const stmts = [
    db.prepare(
      `UPDATE bookings SET status = ?4, name = ?5, email = ?6, phone = ?7, notes = ?8, location_key = ?9, location_detail = ?10,
         visitor_tz = ?11, confirmed_at = ?12, request_expires_at = ?13,
         hold_expires_at = CASE WHEN ?14 THEN ?15 ELSE NULL END, verify_pending = ?14,
         hold_token_hash = CASE WHEN ?14 THEN hold_token_hash ELSE NULL END,
         net_hash = CASE WHEN ?14 THEN net_hash ELSE NULL END, op = ?2
       WHERE id = ?1 AND status = 'held' AND hold_expires_at > ?16 AND hold_token_hash = ?3 AND verify_pending = 0`,
    ).bind(
      id, nonce, tokenHash, status, details.name, details.email, details.phone || null, details.notes || null, details.location,
      locationDetail || null, details.timeZone || null, status === "confirmed" ? sqlTime(now) : null, requestExpires,
      verify ? 1 : 0, now + VERIFY_MINUTES * MIN, now,
    ),
    ...plan.map((p) => deliveryStmt(db, id, nonce, p, now)),
  ];
  let results;
  try {
    results = await db.batch(stmts);
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  }
  if (results[0].meta.changes !== 1) {
    if (b.status === "expired" || (b.status === "held" && b.hold_expires_at <= now)) return { ok: false, error: "expired" };
    if (b.status === "held" && b.hold_token_hash !== tokenHash) return { ok: false, error: "token" };
    return { ok: false, error: "used" };
  }
  return { ok: true, status: verify ? "verify" : status, booking: await loadBooking(env, id) };
}

/** What the location says once booked (link, address, your number). */
export function defaultLocationDetail(loc, details = {}) {
  if (loc.kind === "video") return loc.link;
  if (loc.kind === "in-person") return [loc.address, loc.map].filter(Boolean).join(" ");
  if (loc.kind === "phone") return loc.who === "owner-number" ? loc.number : details.phone ?? "";
  return "";
}

/** "Confirm your email": the visitor clicked the link (a POST from the page it opens). */
export async function verifyEmail(app, b, type, now) {
  const db = app.env.DB;
  const nonce = randomHex(8);
  const status = type.approval ? "requested" : "confirmed";
  const requestExpires = status === "requested" ? Math.min(now + type.requestHours * HOUR, b.start_ms) : null;
  const plan = deliveryPlan(app.cfg, type, { ...b, status }, status, b.sequence, now);
  const stmts = [
    db.prepare(
      `UPDATE bookings SET status = ?3, verify_pending = 0, hold_expires_at = NULL, hold_token_hash = NULL, net_hash = NULL,
         confirmed_at = ?4, request_expires_at = ?5, op = ?2
       WHERE id = ?1 AND status = 'held' AND verify_pending = 1 AND hold_expires_at > ?6`,
    ).bind(b.id, nonce, status, status === "confirmed" ? sqlTime(now) : null, requestExpires, now),
    ...plan.map((p) => deliveryStmt(db, b.id, nonce, p, now)),
  ];
  return runGuarded(db, stmts, 0, b.id, app.env);
}

async function runGuarded(db, stmts, guardIndex, id, env) {
  let results;
  try {
    results = await db.batch(stmts);
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  }
  if (results[guardIndex].meta.changes !== 1) return { ok: false, error: "changed" };
  return { ok: true, booking: await loadBooking(env, id) };
}

/**
 * Cancels (by visitor or owner), declines, or releases a hold. Cells and
 * counts are released and the sequence goes up, in one batch.
 * kind: "cancelled" | "declined" | "released" (a hold given up; no emails)
 */
export async function cancel(app, b, { by, reason = null, now, kind = "cancelled", notify: send = true }) {
  const db = app.env.DB;
  const nonce = randomHex(8);
  const type = app.cfg.types.get(b.type_id);
  const allowed = kind === "released" ? ["held"] : kind === "declined" ? ["requested", "decline_requested", "approve_requested"] : [...LIVE, "held"];
  const seq = b.sequence + (kind === "released" ? 0 : 1);
  const status = kind === "declined" ? "declined" : "cancelled";
  const notify = !send || kind === "released" || b.status === "held" ? [] : deliveryPlan(app.cfg, type, b, kind === "declined" ? "declined" : "cancelled", seq, now);
  const stmts = [
    db.prepare(
      `UPDATE bookings SET op = ?2 WHERE id = ?1 AND status IN (${inList(allowed)}) AND sequence = ?3
         AND EXISTS (SELECT 1 FROM slot_cells WHERE booking_id = ?1)`,
    ).bind(b.id, nonce, b.sequence),
    countDown(db, b.id, nonce, b.local_day, b.type_id),
    countDown(db, b.id, nonce, b.local_day, "*"),
    releaseCells(db, b.id, nonce),
    skipReminders(db, b.id, nonce, kind === "declined" ? "declined" : "cancelled"),
    db.prepare(
      `UPDATE bookings SET status = ?3, sequence = ?4, cancelled_at = ?5, cancelled_by = ?6, cancel_reason = ?7,
         hold_token_hash = NULL, net_hash = NULL, hold_expires_at = NULL, verify_pending = 0
       WHERE id = ?1 AND op = ?2`,
    ).bind(b.id, nonce, status, seq, sqlTime(now), by, reason),
    ...notify.map((p) => deliveryStmt(db, b.id, nonce, p, now)),
  ];
  return runGuarded(db, stmts, 0, b.id, app.env);
}

/** Approves a request (optionally with a video link for this booking). */
export async function approve(app, b, { link = null, now }) {
  const db = app.env.DB;
  const nonce = randomHex(8);
  const type = app.cfg.types.get(b.type_id);
  const plan = deliveryPlan(app.cfg, type, { ...b, status: "confirmed" }, "confirmed", b.sequence, now);
  const stmts = [
    db.prepare(
      `UPDATE bookings SET op = ?2 WHERE id = ?1 AND sequence = ?3 AND start_ms > ?4
         AND (status = 'approve_requested' OR (status = 'requested' AND request_expires_at > ?4))
         AND EXISTS (SELECT 1 FROM slot_cells WHERE booking_id = ?1)`,
    ).bind(b.id, nonce, b.sequence, now),
    db.prepare(
      `UPDATE bookings SET status = 'confirmed', confirmed_at = ?3, request_expires_at = NULL,
         location_detail = COALESCE(?4, location_detail) WHERE id = ?1 AND op = ?2`,
    ).bind(b.id, nonce, sqlTime(now), link),
    ...plan.map((p) => deliveryStmt(db, b.id, nonce, p, now)),
  ];
  return runGuarded(db, stmts, 0, b.id, app.env);
}

/**
 * Moves a booking: the new cells are claimed and the old ones released in
 * one batch (old first, so a move by 15 minutes can overlap itself).
 */
export async function reschedule(app, b, type, startMs, now) {
  const { env, cfg } = app;
  const db = env.DB;
  const nonce = randomHex(8);
  const day = localDate(cfg.owner.timeZone, startMs);
  const minutes = Math.round((b.end_ms - b.start_ms) / MIN) || type.minutes;
  const end = startMs + minutes * MIN;
  const seq = b.sequence + 1;
  const moved = { ...b, start_ms: startMs, end_ms: end };
  const plan = deliveryPlan(cfg, type, moved, "changed", seq, now);
  const stmts = [
    ...expireStatements(db, now),
    db.prepare(
      `UPDATE bookings SET op = ?2 WHERE id = ?1 AND status IN ('confirmed', 'requested') AND sequence = ?3
         AND EXISTS (SELECT 1 FROM slot_cells WHERE booking_id = ?1)`,
    ).bind(b.id, nonce, b.sequence),
    releaseCells(db, b.id, nonce),
    claimCells(db, b.id, nonce, cellsFor(type, startMs, minutes)),
    countDown(db, b.id, nonce, b.local_day, b.type_id),
    countDown(db, b.id, nonce, b.local_day, "*"),
    countUp(db, b.id, nonce, day, b.type_id, type.dailyCap),
    countUp(db, b.id, nonce, day, "*", cfg.owner.dailyCap),
    skipReminders(db, b.id, nonce, "rescheduled"),
    db.prepare(
      `UPDATE bookings SET start_ms = ?3, end_ms = ?4, claim_end_ms = ?5, local_day = ?6, start_at = ?7, sequence = ?8,
         request_expires_at = CASE WHEN request_expires_at IS NULL THEN NULL ELSE MIN(request_expires_at, ?3) END
       WHERE id = ?1 AND op = ?2`,
    ).bind(b.id, nonce, startMs, end, end + type.bufferAfter * MIN, day, sqlTime(startMs), seq),
    ...plan.map((p) => deliveryStmt(db, b.id, nonce, p, now)),
  ];
  return runGuarded(db, stmts, 4, b.id, env);
}

/** Changes the location detail (e.g. a video link); the invite is updated. */
export async function setLocation(app, b, detail, now) {
  const db = app.env.DB;
  const nonce = randomHex(8);
  const type = app.cfg.types.get(b.type_id);
  const seq = b.sequence + 1;
  const plan = deliveryPlan(app.cfg, type, b, "changed", seq, now).filter((p) => !p.kind.startsWith("reminder_"));
  const stmts = [
    db.prepare(`UPDATE bookings SET op = ?2 WHERE id = ?1 AND status IN ('confirmed', 'requested') AND sequence = ?3`).bind(b.id, nonce, b.sequence),
    db.prepare(`UPDATE bookings SET location_detail = ?3, sequence = ?4 WHERE id = ?1 AND op = ?2`).bind(b.id, nonce, detail, seq),
    ...plan.map((p) => deliveryStmt(db, b.id, nonce, p, now)),
  ];
  return runGuarded(db, stmts, 0, b.id, app.env);
}

export async function loadBooking(env, id) {
  return env.DB.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first();
}
