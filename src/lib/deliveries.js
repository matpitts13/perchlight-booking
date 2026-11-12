// Sending notifications, once each. Adapted from perchlight-forms
// src/lib/deliveries.js: claim-then-send (a row is claimed with a conditional
// UPDATE, and only the caller whose UPDATE changed it sends), finish matching
// only its own claim, retries after 1, 5, 30 minutes, 2 hours and 12 hours,
// then failed after 24 hours. Here also: reminders whose meeting has started
// are dropped as "skipped" (never sent late), and emails to visitors have
// their own caps and are never retried after an unknown outcome.
import { ownerSender, visitorSender } from "./senders/index.js";
import { buildEmail } from "./notify.js";
import { hmacHex } from "./crypto.js";
import { sqlTime, utcDay } from "./http.js";
import { spend, left, COST } from "./budget.js";
import { loadBooking } from "./bookings.js";

export const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
export const WINDOW_MS = 24 * 3600_000;
export const STALE_MS = 2 * 60_000;
const VISITOR_FIRST = new Set(["visitor_confirm", "visitor_verify", "visitor_request"]);

const errText = (err) => (err instanceof Error ? err.message : String(err));

async function claim(env, id, now) {
  const r = await env.DB.prepare(
    `UPDATE deliveries SET status = 'sending', claimed_at = ?2, attempts = attempts + 1
     WHERE id = ?1 AND status IN ('pending', 'retry') AND next_attempt_at <= ?2`,
  ).bind(id, now).run();
  return r.meta.changes === 1;
}

async function finish(env, id, claimedAt, { status, nextAt = 0, error = null, sent = false }) {
  await env.DB.prepare(
    `UPDATE deliveries SET status = ?3, next_attempt_at = ?4, last_error = ?5, claimed_at = NULL,
       sent_at = CASE WHEN ?6 THEN ?7 ELSE sent_at END
     WHERE id = ?1 AND status = 'sending' AND claimed_at = ?2`,
  ).bind(id, claimedAt, status, nextAt, error ? String(error).slice(0, 500) : null, sent ? 1 : 0, sqlTime(claimedAt)).run();
}

/** When to try again, or null if past the 24-hour window (or past the meeting's start for a reminder). */
export function nextAttempt(attempts, windowStart, now, notAfter = Infinity) {
  const minutes = BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1];
  const at = now + minutes * 60_000;
  return at > windowStart + WINDOW_MS || at >= notAfter ? null : at;
}

/** A visitor email's caps: per address per day (first emails only) and per deployment per day. */
async function visitorCaps(app, d, b, now) {
  const { env, cfg } = app;
  const day = utcDay(now);
  const stmts = [];
  let hash = null;
  if (VISITOR_FIRST.has(d.kind)) {
    hash = await hmacHex(env.IP_SALT, `email:${b.email}`);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO email_counts (email_hash, day, n) VALUES (?1, ?2, 1)
         ON CONFLICT (email_hash, day) DO UPDATE SET n = n + 1 WHERE email_counts.n < ?3 RETURNING n`,
      ).bind(hash, day, cfg.limits.visitorEmailsPerAddressPerDay),
    );
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO daily_counts (day, kind, count) VALUES (?1, 'visitor_email', 1)
       ON CONFLICT (day, kind) DO UPDATE SET count = count + 1 WHERE daily_counts.count < ?2 RETURNING count`,
    ).bind(day, cfg.limits.visitorEmailsPerDay),
  );
  const res = await env.DB.batch(stmts);
  const perAddress = hash ? res[0].results.length > 0 : true;
  const perDay = res[res.length - 1].results.length > 0;
  const release = async () => {
    const r = [];
    if (hash && perAddress) r.push(env.DB.prepare("UPDATE email_counts SET n = n - 1 WHERE email_hash = ?1 AND day = ?2 AND n > 0").bind(hash, day));
    if (perDay) r.push(env.DB.prepare("UPDATE daily_counts SET count = count - 1 WHERE day = ?1 AND kind = 'visitor_email' AND count > 0").bind(day));
    if (r.length) await env.DB.batch(r);
  };
  if (!perAddress) {
    await release();
    return { error: `already sent ${cfg.limits.visitorEmailsPerAddressPerDay} to this address today` };
  }
  if (!perDay) {
    await release();
    return { error: `the daily cap of visitor emails (${cfg.limits.visitorEmailsPerDay}) was reached` };
  }
  return { release };
}

/** Sends one claimed delivery and returns what happened. */
async function attempt(app, d, b, now) {
  const email = await buildEmail(app, d, b);
  if ("skip" in email) return { status: "skipped", error: email.skip };
  if (email.toVisitor) {
    if (app.cfg.visitorEmail === "none") return { status: "skipped", error: 'visitorEmail is "none"' };
    const got = visitorSender(app.env);
    if ("error" in got) return { status: "config", error: got.error };
    if (!spend(app.budget, COST.visitorCaps)) return { status: "retry", error: "out of budget this run" };
    const caps = await visitorCaps(app, d, b, now);
    if (caps.error) return { status: "skipped", error: caps.error };
    let r;
    try {
      r = await got.sender.send({ to: email.to, subject: email.subject, text: email.text, html: email.html, calendar: email.calendar }, { idempotencyKey: d.id });
    } catch (err) {
      r = { status: "unknown", error: errText(err) };
    }
    if (r.status === "sent") return r;
    // Never retried on an unknown outcome: a visitor must not get two.
    if (r.status === "unknown" || r.status === "conflict") return { status: "unknown", error: r.error };
    await caps.release();
    return r;
  }
  const got = ownerSender(app.env);
  if ("error" in got) return { status: "config", error: got.error };
  try {
    return await got.sender.send(
      { to: email.to, subject: email.subject, text: email.text, html: email.html, calendar: email.calendar, headers: email.replyTo ? { "Reply-To": email.replyTo } : {} },
      { idempotencyKey: d.id },
    );
  } catch (err) {
    return { status: "retry", error: errText(err) };
  }
}

/** Claims, sends and records one delivery row. Returns its new status, or null if someone else had it. */
export async function deliver(app, d, now = app.now(), cache = new Map()) {
  const { env } = app;
  try {
    if (!(await claim(env, d.id, now))) return null;
  } catch (err) {
    console.error(`claim ${d.id}: ${errText(err)}`);
    return null;
  }
  let r;
  let b = null;
  try {
    if (d.booking_id) {
      b = cache.get(d.booking_id);
      if (b === undefined) {
        b = await loadBooking(env, d.booking_id);
        cache.set(d.booking_id, b);
      }
    }
    r = await attempt(app, d, b, now);
  } catch (err) {
    r = { status: "retry", error: errText(err) };
  }
  const isReminder = d.kind.startsWith("reminder_");
  let outcome;
  switch (r.status) {
    case "sent":
      outcome = { status: "sent", sent: true };
      break;
    case "skipped":
      outcome = { status: "skipped", error: r.error ?? null };
      break;
    case "unknown":
    case "conflict":
      if (d.kind.startsWith("visitor_") || d.kind.startsWith("reminder_visitor_")) {
        outcome = { status: "unknown", error: r.error };
        break;
      }
    // falls through: notifications to you are retried
    case "retry":
    case "throttled": {
      const at = nextAttempt((d.attempts ?? 0) + 1, d.due_ms, now, isReminder && b ? b.start_ms : Infinity);
      outcome = at === null
        ? { status: isReminder ? "skipped" : "failed", error: isReminder ? `not sent before the meeting started: ${r.error}` : `gave up after 24 hours: ${r.error}` }
        : { status: "retry", nextAt: at, error: r.error };
      break;
    }
    default: // config, rejected: a setup problem; not retried every few minutes
      outcome = { status: "failed", error: r.error };
  }
  try {
    await finish(env, d.id, now, outcome);
  } catch (err) {
    console.error(`finish ${d.id}: ${errText(err)}`);
  }
  return outcome.status;
}

/** Sends one booking's due deliveries (right after the reply). */
export async function deliverBooking(app, bookingId, now = app.now()) {
  if (!spend(app.budget, COST.deliverySelect)) return [];
  const { results } = await app.env.DB.prepare(
    "SELECT * FROM deliveries WHERE booking_id = ?1 AND status IN ('pending', 'retry') AND next_attempt_at <= ?2 ORDER BY next_attempt_at",
  ).bind(bookingId, now).all();
  const cache = new Map();
  const out = [];
  for (const d of results) {
    if (!spend(app.budget, COST.delivery)) break;
    out.push(await deliver(app, d, now, cache));
  }
  return out;
}

/** Sends up to `limit` due deliveries, oldest first. */
export async function deliverDue(app, limit, now = app.now()) {
  if (left(app.budget) < COST.deliverySelect + COST.delivery) return { tried: 0, sent: 0 };
  spend(app.budget, COST.deliverySelect);
  const { results } = await app.env.DB.prepare(
    "SELECT * FROM deliveries WHERE status IN ('pending', 'retry') AND next_attempt_at <= ?1 ORDER BY next_attempt_at LIMIT ?2",
  ).bind(now, limit).all();
  const cache = new Map();
  let sent = 0;
  let tried = 0;
  for (const d of results) {
    if (!spend(app.budget, COST.delivery)) break;
    tried++;
    if ((await deliver(app, d, now, cache)) === "sent") sent++;
  }
  return { tried, sent, more: results.length === limit };
}

/** Claims older than 2 minutes belong to a run that died: visitor emails
 *  become "unknown" (never sent twice); everything else is tried again. */
export function releaseStaleStatements(db, now) {
  return [
    db.prepare(
      `UPDATE deliveries SET status = 'unknown', claimed_at = NULL,
         last_error = 'the send was interrupted; it may or may not have gone out'
       WHERE status = 'sending' AND claimed_at < ?1 AND (kind LIKE 'visitor_%' OR kind LIKE 'reminder_visitor_%')`,
    ).bind(now - STALE_MS),
    db.prepare(`UPDATE deliveries SET status = 'retry', claimed_at = NULL, next_attempt_at = ?2 WHERE status = 'sending' AND claimed_at < ?1`).bind(now - STALE_MS, now),
  ];
}
