// The admin API: everything under /api/ except types, slots, hold and
// confirm, behind Authorization: Bearer <ADMIN_TOKEN> (16+ characters,
// compared in constant time), as perchlight-forms / perchlight-updates.
import { json, fail, readBody, sqlTime, escapeHtml } from "../lib/http.js";
import { safeEqual, isId } from "../lib/crypto.js";
import { settings } from "../lib/settings.js";
import { loadBooking, cancel, approve, setLocation, hold, confirm } from "../lib/bookings.js";
import { checkDetails, isEmail, oneLine } from "../lib/validate.js";
import { ruleProblem, dayStarts } from "../lib/slots.js";
import { windowData, parseRangesJson } from "../lib/store.js";
import { readBusy, sources, askClock } from "../lib/busy.js";
import { parseRanges } from "../lib/config.js";
import { deliverBooking, deliver } from "../lib/deliveries.js";
import { runHousekeeping, scheduleNext, ANONYMISE } from "../lib/housekeeping.js";
import { ownerSender, visitorSender, providerName } from "../lib/senders/index.js";
import { buildEmail } from "../lib/notify.js";
import { manageUrl } from "../lib/links.js";
import { localDate, parseDate, formatWhen } from "../lib/tz.js";
import { spend, COST } from "../lib/budget.js";

const MIN_TOKEN = 16;
const DAY = 86_400_000;
const LIVE = "('confirmed', 'requested', 'cancel_requested', 'approve_requested', 'decline_requested')";
const STATUSES = new Set(["held", "requested", "confirmed", "cancelled", "declined", "expired", "cancel_requested", "approve_requested", "decline_requested"]);
export const ERASE_BATCH = 40;

async function authorised(request, env) {
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  return Boolean(m) && (await safeEqual(m[1], env.ADMIN_TOKEN));
}

export async function handleAdmin(request, app, ctx, path) {
  const { env } = app;
  if (!env.ADMIN_TOKEN || String(env.ADMIN_TOKEN).length < MIN_TOKEN) {
    return fail(503, `Set ADMIN_TOKEN (${MIN_TOKEN}+ characters): npx wrangler secret put ADMIN_TOKEN`);
  }
  if (!(await authorised(request, env))) return json({ ok: false, error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  spend(app.budget, COST.admin);
  const q = new URL(request.url).searchParams;
  const m = request.method;
  const seg = path.split("/");

  if (path === "config" && m === "GET") return getConfig(app);
  if (path === "bookings" && m === "GET") return listBookings(app, q);
  if (path === "bookings" && m === "POST") return bookOnBehalf(request, app, ctx);
  if (path === "bookings" && m === "DELETE") return eraseByEmail(app, ctx, q);
  if (seg[0] === "bookings" && seg.length === 2 && isId("bk", seg[1])) {
    if (m === "GET") return getBooking(app, seg[1]);
    if (m === "PATCH") return patchBooking(request, app, ctx, seg[1]);
  }
  if (path === "exceptions") {
    if (m === "GET") return json({ ok: true, exceptions: (await env.DB.prepare("SELECT * FROM exceptions WHERE date >= ?1 ORDER BY date LIMIT 500").bind(q.get("from") ?? localDate(app.cfg.owner.timeZone, app.now())).all()).results.map((r) => ({ ...r, ranges: parseRangesJson(r.ranges) })) });
    if (m === "POST") return putException(request, app);
    if (m === "DELETE") return deleteRow(env, "exceptions", "date", q.get("date"));
  }
  if (path === "blocked") {
    if (m === "GET") return json({ ok: true, blocked: (await env.DB.prepare("SELECT * FROM blocked ORDER BY value LIMIT 1000").all()).results });
    if (m === "POST") return putBlocked(request, app);
    if (m === "DELETE") return deleteRow(env, "blocked", "value", (q.get("value") ?? "").toLowerCase());
  }
  if (path === "calendar-check" && m === "GET") return calendarCheck(app);
  if (path === "deliveries" && m === "GET") {
    const status = q.get("status") ?? "failed";
    const { results } = await env.DB.prepare("SELECT * FROM deliveries WHERE status = ?1 ORDER BY created_ms DESC LIMIT 200").bind(status).all();
    return json({ ok: true, deliveries: results });
  }
  if (seg[0] === "deliveries" && seg[2] === "retry" && m === "POST") return retryDelivery(app, seg[1]);
  if (path === "export" && m === "GET") return exportByEmail(app, q);
  if (path === "test-notify" && m === "POST") return testNotify(request, app);
  if (path === "housekeeping" && m === "POST") {
    const r = await runHousekeeping(app, { force: true });
    ctx.waitUntil(scheduleNext(app).catch(() => null));
    return json({ ok: true, ...r });
  }
  return fail(404, "No such endpoint. See the README's Admin API section.");
}

async function getConfig(app) {
  const { env, cfg } = app;
  const now = app.now();
  const busy = await readBusy(app, now);
  let nextAlarm = null;
  if (env.CLOCK) {
    try {
      nextAlarm = await env.CLOCK.get(env.CLOCK.idFromName("clock")).getNext();
    } catch {
      nextAlarm = "unavailable";
    }
  }
  // Upcoming bookings that are now outside your availability (hours changed, a day off added).
  const { results: upcoming } = await env.DB.prepare(`SELECT id, type_id, start_ms, local_day FROM bookings WHERE status IN ${LIVE} AND start_ms > ?1 ORDER BY start_ms LIMIT 100`).bind(now).all();
  const ex = upcoming.length ? (await windowData(app, now, upcoming[upcoming.length - 1].start_ms + DAY, now)).exceptions : new Map();
  const outside = upcoming
    .filter((b) => {
      const t = cfg.types.get(b.type_id);
      if (!t) return true;
      return ![b.local_day, prevDay(b.local_day)].some((d) => dayStarts(cfg, t, d, ex).includes(b.start_ms));
    })
    .map((b) => ({ id: b.id, type: b.type_id, start: new Date(b.start_ms).toISOString() }));
  return json({
    ok: true,
    configOk: cfg.ok,
    errors: cfg.errors,
    warnings: setupWarnings(app),
    owner: { name: cfg.owner.name, timeZone: cfg.owner.timeZone },
    types: [...cfg.types.values()].map((t) => ({ id: t.id, name: t.name, on: t.on, errors: t.errors, minutes: t.minutes, approval: t.approval })),
    visitorEmail: cfg.visitorEmail,
    mailProvider: providerName(env),
    turnstile: Boolean(env.TURNSTILE_SECRET_KEY),
    noJs: cfg.noJs,
    calendar: {
      links: busy.list.length,
      paused: busy.paused,
      problems: busy.problems,
      sources: busy.list.map((s) => {
        const r = busy.rows.get(s.key);
        return { kind: s.kind, lastGood: r?.ok_at ? new Date(r.ok_at).toISOString() : null, lastTry: r?.fetched_at ? new Date(r.fetched_at).toISOString() : null, error: r?.error ?? null };
      }),
    },
    nextAlarm: typeof nextAlarm === "number" ? new Date(nextAlarm).toISOString() : nextAlarm,
    outsideAvailability: outside,
  });
}

/** Setup problems that depend on secrets and vars, not booking.json. */
function setupWarnings(app) {
  const { env, cfg } = app;
  const w = [];
  if (!env.MAIL_FROM) w.push("MAIL_FROM isn't set: no emails can be sent.");
  if (!env.TURNSTILE_SECRET_KEY) w.push("TURNSTILE_SECRET_KEY isn't set: holds rely on the rate limits alone.");
  if (cfg.visitorEmail !== "none" && providerName(env) === "cloudflare-routing") w.push(`visitorEmail is "${cfg.visitorEmail}" but MAIL_PROVIDER is cloudflare-routing, which can't reach visitors.`);
  if (cfg.visitorEmail !== "none" && !env.TURNSTILE_SECRET_KEY) w.push("Visitor emails are only sent for bookings that passed Turnstile: set TURNSTILE_SECRET_KEY.");
  if (!env.CALENDAR_ICS_URLS) w.push("CALENDAR_ICS_URLS isn't set: your calendar's busy times aren't checked.");
  if (!String(env.PUBLIC_URL ?? "").trim()) w.push("PUBLIC_URL isn't set: links and invite UIDs use the address each request came in on.");
  if (!env.FEED_SECRET) w.push("FEED_SECRET isn't set: the bookings feed is off.");
  return w;
}

function prevDay(d) {
  const p = parseDate(d);
  return new Date(Date.UTC(p.y, p.mo - 1, p.d - 1)).toISOString().slice(0, 10);
}

function rowOut(b) {
  return {
    ...b,
    start: new Date(b.start_ms).toISOString(),
    end: new Date(b.end_ms).toISOString(),
    hold_token_hash: undefined,
    net_hash: undefined,
    op: undefined,
  };
}

async function listBookings(app, q) {
  const status = q.get("status");
  if (status && !STATUSES.has(status)) return fail(422, `status must be one of ${[...STATUSES].join(", ")}`);
  const from = q.get("from") ? Date.parse(q.get("from")) : app.now() - 30 * DAY;
  const to = q.get("to") ? Date.parse(q.get("to")) : app.now() + 400 * DAY;
  const limit = Math.min(Math.max(Number.parseInt(q.get("limit") ?? "50", 10) || 50, 1), 200);
  let cursor = null;
  if (q.get("cursor")) {
    const mm = /^(\d+)\.(bk_[a-z0-9]{16})$/.exec(q.get("cursor"));
    if (!mm) return fail(422, "Bad cursor.");
    cursor = { start: Number(mm[1]), id: mm[2] };
  }
  const { results } = await app.env.DB.prepare(
    `SELECT * FROM bookings WHERE start_ms >= ?1 AND start_ms <= ?2 AND (?3 IS NULL OR status = ?3)
       AND (?4 IS NULL OR start_ms > ?4 OR (start_ms = ?4 AND id > ?5))
     ORDER BY start_ms, id LIMIT ?6`,
  ).bind(from, to, status, cursor?.start ?? null, cursor?.id ?? "", limit + 1).all();
  const more = results.length > limit;
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return json({ ok: true, bookings: page.map(rowOut), cursor: more && last ? `${last.start_ms}.${last.id}` : null });
}

async function getBooking(app, id) {
  const b = await loadBooking(app.env, id);
  if (!b) return fail(404, "No such booking.");
  const { results } = await app.env.DB.prepare("SELECT * FROM deliveries WHERE booking_id = ?1 ORDER BY created_ms").bind(id).all();
  return json({ ok: true, booking: rowOut(b), deliveries: results, manageUrl: await manageUrl(app, b) });
}

/** { action: "approve" | "decline" | "cancel" | "location", link?, reason?, block? } */
async function patchBooking(request, app, ctx, id) {
  const body = await readBody(request);
  if (!body) return fail(400, "Send a JSON body.");
  const b = await loadBooking(app.env, id);
  if (!b) return fail(404, "No such booking.");
  const now = app.now();
  const reason = oneLine(body.reason, 300) || null;
  const link = oneLine(body.link, 500);
  if (link && !/^https:\/\/\S+$/.test(link)) return fail(422, "link must be an https:// link.");
  let r;
  if (body.action === "approve") r = await approve(app, b, { link: link || null, now });
  else if (body.action === "decline") r = await cancel(app, b, { by: "owner", reason, now, kind: "declined" });
  else if (body.action === "cancel") r = await cancel(app, b, { by: "owner", reason, now });
  else if (body.action === "location") {
    if (!link && !body.detail) return fail(422, "Give link (a video link) or detail.");
    r = await setLocation(app, b, link || oneLine(body.detail, 500), now);
  } else return fail(422, 'action must be "approve", "decline", "cancel" or "location".');
  if (!r.ok) return fail(r.error === "db" ? 503 : 409, r.error === "db" ? "D1 refused the change; nothing was changed." : `The booking is ${b.status}; nothing was changed.`);
  if (body.block === true && b.email) {
    await app.env.DB.prepare("INSERT OR IGNORE INTO blocked (value, note, created_at) VALUES (?1, ?2, ?3)").bind(b.email, "cancel and block", sqlTime(now)).run();
  }
  ctx.waitUntil(deliverBooking(app, id).then(() => scheduleNext(app)).catch(() => null));
  return json({ ok: true, booking: rowOut(r.booking) });
}

/** Book on someone's behalf: same constraints (cells, caps, rules), no Turnstile. */
async function bookOnBehalf(request, app, ctx) {
  const body = await readBody(request);
  if (!body) return fail(400, "Send a JSON body.");
  const { cfg } = app;
  const type = cfg.types.get(String(body.type ?? ""));
  if (!type || !type.on) return fail(422, "No such booking type (or it's switched off).");
  const startMs = Date.parse(String(body.start ?? ""));
  if (!Number.isFinite(startMs) || !/Z$|[+-]\d{2}:\d{2}$/.test(String(body.start))) return fail(422, "start must be a UTC time (ISO 8601).");
  const now = app.now();
  const ex = (await windowData(app, startMs - DAY, startMs + DAY, now)).exceptions;
  // Even outside your hours, a start must sit on the cell grid (cells are what prevent double booking).
  const rule = body.ignoreRules === true ? (startMs % (type.cell * 60_000) ? "That start isn't on the slot grid." : null) : ruleProblem(cfg, type, startMs, now, ex);
  if (rule) return fail(422, `${rule} (send "ignoreRules": true to book outside your hours anyway)`);
  const d = checkDetails(cfg, type, body);
  if (!d.ok) return fail(422, "Check the fields.", { errors: d.errors });
  const h = await hold(app, { type, startMs, now, via: "owner" });
  if (!h.ok) return fail(h.error === "db" ? 503 : 409, { taken: "That time is taken.", full: "That day is full." }[h.error] ?? "Couldn't hold the time.");
  const r = await confirm(app, { id: h.id, token: h.token, details: { ...d.value, timeZone: d.value.timeZone || cfg.owner.timeZone }, type: { ...type, approval: false }, now });
  if (!r.ok) return fail(503, "Couldn't confirm the booking.");
  ctx.waitUntil(deliverBooking(app, h.id).then(() => scheduleNext(app)).catch(() => null));
  return json({ ok: true, booking: rowOut(r.booking), manageUrl: await manageUrl(app, r.booking) });
}

async function putException(request, app) {
  const body = await readBody(request);
  if (!body) return fail(400, "Send a JSON body.");
  if (!parseDate(body.date)) return fail(422, "date must be YYYY-MM-DD (your time zone).");
  const kind = body.kind === "hours" ? "hours" : body.kind === "off" ? "off" : null;
  if (!kind) return fail(422, 'kind must be "off" or "hours".');
  let ranges = null;
  if (kind === "hours") {
    const r = parseRanges(body.ranges, app.cfg.cell, "ranges");
    if (typeof r === "string") return fail(422, r);
    ranges = JSON.stringify(r);
  }
  await app.env.DB.prepare(
    `INSERT INTO exceptions (date, kind, ranges, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (date) DO UPDATE SET kind = excluded.kind, ranges = excluded.ranges, note = excluded.note`,
  ).bind(body.date, kind, ranges, oneLine(body.note, 200) || null, sqlTime(app.now())).run();
  return json({ ok: true });
}

async function putBlocked(request, app) {
  const body = await readBody(request);
  const v = oneLine(body?.value, 254).toLowerCase();
  if (!isEmail(v) && !/^@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return fail(422, 'value must be an address or "@domain".');
  await app.env.DB.prepare("INSERT OR IGNORE INTO blocked (value, note, created_at) VALUES (?1, ?2, ?3)").bind(v, oneLine(body.note, 200) || null, sqlTime(app.now())).run();
  return json({ ok: true });
}

async function deleteRow(env, table, col, value) {
  if (!value) return fail(422, `Give ?${col === "date" ? "date" : "value"}=`);
  const r = await env.DB.prepare(`DELETE FROM ${table} WHERE ${col} = ?1`).bind(value).run();
  return json({ ok: true, deleted: r.meta.changes });
}

/** Has the Clock fetch every ICS link now and reports (the busy cache is updated too). */
async function calendarCheck(app) {
  const now = app.now();
  const { list, problems } = await sources(app);
  if (!list.length && !problems.length) return json({ ok: true, links: 0, note: "No CALENDAR_ICS_URLS set: only bookings made here block time." });
  if (problems.length) return json({ ok: false, links: list.length, problems, note: "Bookings are paused until CALENDAR_ICS_URLS is fixed." });
  if (!app.env.CLOCK) return fail(503, "The CLOCK Durable Object binding is missing from wrangler.jsonc; it reads the calendar.");
  const r = await askClock(app, true);
  if (!r) return fail(503, "The Clock couldn't be reached; try again in a minute.");
  const out = r.results.map((x) => ({
    kind: x.kind,
    ok: Boolean(x.ok),
    error: x.error ?? x.skipped ?? null,
    bytes: x.stats?.bytes ?? null,
    eventsRead: x.stats?.events ?? null,
    repeatingSeries: x.stats?.series ?? null,
    movedInstances: x.stats?.overrides ?? null,
    unsupportedRules: x.stats?.unsupported ?? [],
    unknownTimeZones: x.stats?.unknownZones ?? [],
    busyNext7Days: (x.intervals ?? []).filter(([a]) => a * 60_000 < now + 7 * DAY).slice(0, 100).map(([a, b]) => ({ start: new Date(a * 60_000).toISOString(), end: new Date(b * 60_000).toISOString() })),
  }));
  return json({ ok: true, links: list.length, results: out, note: `Feeds over FEED_MAX_KB (${settings(app.env).feedMaxKb} KB) pause bookings; parsing runs in the Clock Durable Object.` });
}
async function retryDelivery(app, id) {
  const r = await app.env.DB.prepare(
    `UPDATE deliveries SET status = 'pending', next_attempt_at = ?2, due_ms = ?2, attempts = 0, last_error = NULL
     WHERE id = ?1 AND status IN ('failed', 'unknown', 'skipped') RETURNING *`,
  ).bind(id, app.now()).first();
  if (!r) return fail(404, "No failed delivery with that id.");
  const status = await deliver(app, r, app.now());
  return json({ ok: true, status });
}

/** CSV cell that never runs as a formula (copied from perchlight-forms admin.js). */
export function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EXPORT_COLS = ["id", "type_id", "start_at", "status", "name", "email", "phone", "notes", "location_key", "location_detail", "visitor_tz", "created_at", "confirmed_at", "cancelled_at", "cancelled_by", "cancel_reason"];

async function exportByEmail(app, q) {
  const email = (q.get("email") ?? "").toLowerCase();
  if (!isEmail(email)) return fail(422, "Give ?email=");
  const { results } = await app.env.DB.prepare(`SELECT ${EXPORT_COLS.join(", ")} FROM bookings WHERE email = ?1 ORDER BY start_ms LIMIT 1000`).bind(email).all();
  if ((q.get("format") ?? "json") === "csv") {
    const csv = "﻿" + [EXPORT_COLS.join(","), ...results.map((r) => EXPORT_COLS.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="bookings.csv"', "Cache-Control": "no-store" } });
  }
  return json({ ok: true, email, bookings: results });
}

/**
 * Erasure: removes everything for one address, 40 bookings per call
 * ("more": true while some remain). Upcoming ones are cancelled first (their
 * time is released); then personal details are removed and the row kept as an
 * anonymous record, or deleted with "retentionMode": "delete". Queued
 * notifications for them are dropped. You get one email listing the
 * meetings that were cancelled (type and time only); the visitor isn't
 * emailed, since their address is what's being erased.
 */
async function eraseByEmail(app, ctx, q) {
  const { env, cfg } = app;
  const email = (q.get("email") ?? "").toLowerCase();
  if (!isEmail(email)) return fail(422, "Give ?email=");
  const now = app.now();
  const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE email = ?1 ORDER BY start_ms LIMIT ?2").bind(email, ERASE_BATCH + 1).all();
  const page = results.slice(0, ERASE_BATCH);
  const cancelled = [];
  for (const b of page) {
    if (["held", "confirmed", "requested", "cancel_requested", "approve_requested", "decline_requested"].includes(b.status) && b.start_ms > now) {
      const r = await cancel(app, b, { by: "owner", reason: null, now, kind: b.status === "held" ? "released" : "cancelled", notify: false });
      if (!r.ok) return fail(503, `Couldn't cancel ${b.id}; the bookings before it were erased. Call again.`);
      if (b.status !== "held") cancelled.push({ id: b.id, type: b.type_id, start: new Date(b.start_ms).toISOString() });
    }
  }
  const ids = page.map((b) => b.id);
  if (ids.length) {
    const marks = (from) => ids.map((_, i) => `?${i + from}`).join(", ");
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM deliveries WHERE booking_id IN (${marks(1)})`).bind(...ids),
      cfg.retentionMode === "delete"
        ? env.DB.prepare(`DELETE FROM bookings WHERE id IN (${marks(1)})`).bind(...ids)
        : env.DB.prepare(`UPDATE bookings SET ${ANONYMISE}, anonymised_at = ?1 WHERE id IN (${marks(2)})`).bind(sqlTime(now), ...ids),
    ]);
  }
  let emailed = null;
  if (cancelled.length) {
    const got = ownerSender(env);
    const lines = cancelled.map((c) => `- ${cfg.types.get(c.type)?.name ?? c.type}, ${formatWhen(Date.parse(c.start), cfg.owner.timeZone)}`);
    const textBody = `These upcoming meetings were cancelled because their booker asked to be forgotten:\n${lines.join("\n")}\n\nTheir time is free again. They weren't emailed.`;
    emailed = "error" in got
      ? { status: "config", error: got.error }
      : await got.sender.send({ to: cfg.owner.email, subject: `${cancelled.length} booking(s) cancelled by an erasure request`, text: textBody, html: `<pre>${escapeHtml(textBody)}</pre>`, headers: {} });
  }
  ctx.waitUntil(scheduleNext(app).catch(() => null));
  return json({ ok: true, erased: ids.length, cancelledUpcoming: cancelled, ownerEmail: emailed?.status ?? null, more: results.length > ERASE_BATCH });
}

/** A sample booking email with .ics to you (and to `visitor` if an email service is set). */
async function testNotify(request, app) {
  const body = (await readBody(request)) ?? {};
  const { cfg } = app;
  const type = [...cfg.types.values()].find((t) => t.on) ?? [...cfg.types.values()][0];
  if (!type) return fail(422, "No event types.");
  const start = Math.ceil((app.now() + 2 * DAY) / 900_000) * 900_000;
  const sample = {
    id: "bk_testtesttesttestt".slice(0, 19), type_id: type.id, start_ms: start, end_ms: start + type.minutes * 60_000, status: "confirmed",
    name: "Test Visitor", email: isEmail(body.visitor ?? "") ? body.visitor : "visitor@example.com", phone: null, notes: "This is a test booking from POST /api/test-notify.",
    location_key: type.locations[0], location_detail: cfg.locations[type.locations[0]]?.link || cfg.locations[type.locations[0]]?.address || "", visitor_tz: cfg.owner.timeZone,
    sequence: 0, manage_version: 1, via: "owner", turnstile: "off", cancelled_by: null, cancel_reason: null,
  };
  const results = {};
  const owner = await buildEmail(app, { kind: "owner_new", sequence: 0 }, sample);
  const os = ownerSender(app.env);
  results.owner = "error" in os ? { status: "config", error: os.error } : await os.sender.send({ ...owner, headers: {} });
  if (body.visitor) {
    const vs = visitorSender(app.env);
    const v = await buildEmail(app, { kind: "visitor_confirm", sequence: 0 }, sample);
    results.visitor = "error" in vs ? { status: "config", error: vs.error } : await vs.sender.send(v);
  }
  return json({ ok: true, results, note: "The sample's links don't work (it isn't a real booking)." });
}
