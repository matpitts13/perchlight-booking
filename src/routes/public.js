// The public booking API (used by the JavaScript page) and the no-JavaScript
// path. Every attempt ends as one of: a problem shown to the visitor that they
// can act on, a hold, a request, a confirmed booking, or (later) a
// cancellation; nothing is dropped silently.
import { json, fail, html, redirect, readBody, isFormPost, escapeHtml as e } from "../lib/http.js";
import { settings, secretOk } from "../lib/settings.js";
import { freeSlots, nearest, ruleProblem, overlapsBusy } from "../lib/slots.js";
import { windowData } from "../lib/store.js";
import { freshBusy } from "../lib/busy.js";
import { hold, confirm, cancel, loadBooking } from "../lib/bookings.js";
import { checkDetails } from "../lib/validate.js";
import { hit } from "../lib/ratelimit.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { manageUrl, linkSecretOk } from "../lib/links.js";
import { deliverBooking } from "../lib/deliveries.js";
import { scheduleNext } from "../lib/housekeeping.js";
import { canEmailVisitors } from "../lib/senders/index.js";
import { spend, COST } from "../lib/budget.js";
import { isZone, formatWhen } from "../lib/tz.js";
import { isId } from "../lib/crypto.js";
import { layout, problemPage, timeRadios, detailFields } from "./pages.js";

const MIN = 60_000;
const DAY = 86_400_000;
export const PAUSED = "Bookings are paused while the calendar can't be read. Please try again later.";

/** Why the deployment can't take bookings at all, or null. */
export function setupProblem(env) {
  if (!secretOk(env, "IP_SALT")) return "IP_SALT isn't set (16+ characters).";
  if (!linkSecretOk(env)) return "LINK_SECRET isn't set (16+ characters).";
  return null;
}

function unavailable(app) {
  const c = settings(app.env).fallbackContact;
  return `Booking isn't possible right now.${c ? ` Please contact ${c}.` : ""}`;
}

/** Free slots and busy state for a window. */
export async function slotsFor(app, ctx, type, fromMs, toMs, mode = "slots") {
  const now = app.now();
  spend(app.budget, COST.slots);
  const busy = await freshBusy(app, ctx, now, mode);
  if (busy.paused) return { paused: true, slots: [], busy };
  const w = await windowData(app, fromMs, toMs, now);
  return { paused: false, slots: freeSlots(app.cfg, type, { fromMs, toMs, now, busy: busy.intervals, ...w }), busy, w };
}

async function nearestFor(app, type, startMs, busy) {
  const now = app.now();
  const w = await windowData(app, startMs - 3 * DAY, startMs + 4 * DAY, now);
  return nearest(app.cfg, type, startMs, { now, busy: busy.intervals, ...w }).map((t) => new Date(t).toISOString());
}

function parseStart(v) {
  if (typeof v === "number") return v;
  const s = String(v ?? "");
  if (/^\d{10,14}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) && /Z$|[+-]\d{2}:\d{2}$/.test(s) ? t : NaN; // UTC instants only, never local times
}

/** The checks and the hold itself, shared by the JS and no-JS paths. */
async function takeHold(app, ctx, request, type, startMs, { via, token }) {
  const { env, cfg } = app;
  const now = app.now();
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  // 1. The rules (cheapest first).
  const ex = (await windowData(app, startMs - DAY, startMs + DAY, now)).exceptions;
  const rule = ruleProblem(cfg, type, startMs, now, ex);
  if (rule) return { status: 422, error: rule, code: "rules" };
  spend(app.budget, COST.hold);
  // 2. Rate limit per network (a daily-keyed hash, never the IP).
  let rate;
  try {
    rate = await hit(env, via === "nojs" ? "nojs" : "hold", ip, via === "nojs" ? cfg.limits.noJsPerHour : cfg.limits.holdsPerHour, now);
  } catch (err) {
    console.error(`rate limit: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 503, error: unavailable(app), code: "db" };
  }
  if (!rate.ok) return { status: 429, error: "Too many attempts from your network. Please try again in an hour.", code: "rate" };
  // 3. Turnstile (JavaScript page only).
  let turnstile = "off";
  if (via === "page" && env.TURNSTILE_SECRET_KEY) {
    spend(app.budget, COST.turnstile);
    const t = await verifyTurnstile(env, token, null);
    if (t.result === "unverified") return { status: 503, error: "The spam check couldn't be reached. Please try again in a minute.", code: "turnstile_down" };
    // The token must come from this site (its workers.dev address or PUBLIC_URL).
    const hosts = [new URL(request.url).hostname, app.host.split(":")[0]];
    if (t.result === "failed" || (t.hostname && !hosts.includes(t.hostname))) return { status: 422, error: "Please complete the check again.", code: "turnstile" };
    turnstile = "passed";
  }
  // 4. Your calendar, fresh enough.
  const busy = await freshBusy(app, ctx, now, "hold");
  if (busy.paused) return { status: 503, error: PAUSED, code: "paused" };
  if (overlapsBusy(busy.intervals, startMs / MIN - type.bufferAfter, startMs / MIN + type.minutes + type.bufferAfter)) {
    return { status: 409, error: "That time was just taken.", code: "taken", nearest: await nearestFor(app, type, startMs, busy) };
  }
  // 5. One batch.
  const h = await hold(app, {
    type, startMs, now, netHash: rate.key, turnstile, via,
    maxActive: cfg.limits.activeHolds, maxPerNetwork: cfg.limits.activeHoldsPerNetwork,
  });
  if (h.ok) {
    ctx.waitUntil(scheduleNext(app).catch(() => null));
    return { ok: true, ...h };
  }
  if (h.error === "taken" || h.error === "full") {
    return { status: 409, error: h.error === "taken" ? "That time was just taken." : "That day is full.", code: h.error, nearest: await nearestFor(app, type, startMs, busy) };
  }
  if (h.error === "network") return { status: 429, error: `You already have ${cfg.limits.activeHoldsPerNetwork} times held. Finish or wait for one to expire.`, code: "holds" };
  if (h.error === "busy") return { status: 429, error: "Many people are choosing a time right now. Please try again in a few minutes.", code: "holds" };
  return { status: 503, error: unavailable(app), code: "db" };
}

/** The checks and the confirmation, shared by the JS and no-JS paths. */
async function finishBooking(app, ctx, b, input) {
  const { env, cfg } = app;
  const now = app.now();
  const type = cfg.types.get(b.type_id);
  if (!type || !type.on) return { status: 422, error: "This booking type isn't set up correctly.", code: "type" };
  spend(app.budget, COST.confirm);
  if (input.website) {
    await cancel(app, b, { by: "system", reason: "honeypot", now, kind: "released" });
    return { status: 422, error: "This booking couldn't be accepted.", code: "spam" };
  }
  const d = checkDetails(cfg, type, input);
  if (!d.ok) return { status: 422, error: "Please check the highlighted fields.", errors: d.errors, code: "fields" };
  if (!isZone(d.value.timeZone)) d.value.timeZone = cfg.owner.timeZone;
  const domain = `@${d.value.email.split("@")[1]}`;
  const [blocked, upcoming] = await env.DB.batch([
    env.DB.prepare("SELECT 1 FROM blocked WHERE value IN (?1, ?2) LIMIT 1").bind(d.value.email, domain),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bookings WHERE email = ?1 AND start_ms > ?2
         AND status IN ('confirmed', 'requested', 'cancel_requested', 'approve_requested', 'decline_requested')`,
    ).bind(d.value.email, now),
  ]);
  if (blocked.results.length) {
    await cancel(app, b, { by: "system", reason: "blocked address", now, kind: "released" });
    return { status: 403, error: "This booking couldn't be accepted.", code: "blocked" };
  }
  if ((upcoming.results[0]?.n ?? 0) >= cfg.limits.upcomingPerEmail) {
    return { status: 429, error: `This address already has ${cfg.limits.upcomingPerEmail} upcoming bookings.`, code: "upcoming" };
  }
  const verify = cfg.visitorEmail === "provider-confirm" && b.turnstile === "passed" && canEmailVisitors(env);
  const r = await confirm(app, { id: b.id, token: input.token, details: d.value, type, now, verify });
  if (!r.ok) {
    if (r.error === "expired") {
      let stillFree = false;
      try {
        const s = await slotsFor(app, ctx, type, b.start_ms, b.start_ms + MIN);
        stillFree = s.slots.includes(b.start_ms);
      } catch {
        stillFree = false;
      }
      return { status: 409, error: "Your hold ran out.", code: "expired", stillFree, start: new Date(b.start_ms).toISOString() };
    }
    if (r.error === "token") return { status: 403, error: "This hold belongs to someone else.", code: "token" };
    if (r.error === "used") return { status: 409, error: "This hold was already used.", code: "used" };
    return { status: 503, error: unavailable(app), code: "db" };
  }
  ctx.waitUntil(
    deliverBooking(app, b.id, now)
      .then(() => scheduleNext(app))
      .catch((err) => console.error(`notify ${b.id}: ${err instanceof Error ? err.message : String(err)}`)),
  );
  return { ok: true, status: r.status, booking: r.booking, manageUrl: r.status === "verify" ? null : await manageUrl(app, r.booking) };
}

export async function publicApi(request, app, ctx, name) {
  const { cfg, env } = app;
  if (name === "types" && request.method === "GET") {
    return json({
      ok: true,
      owner: { name: cfg.owner.name, timeZone: cfg.owner.timeZone },
      types: [...cfg.types.values()].map((t) => ({
        id: t.id, name: t.name, description: t.description, minutes: t.minutes, approval: t.approval, on: t.on,
        locations: t.locations.map((k) => ({ key: k, kind: cfg.locations[k].kind, label: cfg.locations[k].label, who: cfg.locations[k].who })),
      })),
      questions: cfg.questions,
      turnstileSiteKey: env.TURNSTILE_SECRET_KEY ? settings(env).turnstileSiteKey : "",
      noJs: cfg.noJs && cfg.visitorEmail !== "provider-confirm",
      visitorEmail: cfg.visitorEmail,
    });
  }
  const problem = setupProblem(env);
  if (problem) {
    console.error(`setup: ${problem}`);
    return fail(503, unavailable(app));
  }
  if (name === "slots" && request.method === "GET") {
    const q = new URL(request.url).searchParams;
    const type = cfg.types.get(q.get("type") ?? "");
    if (!type) return fail(404, "No such booking type.");
    if (!type.on) return fail(422, "This booking type isn't set up correctly.");
    const now = app.now();
    const from = q.get("from") ? parseStart(q.get("from")) : now;
    const to = q.get("to") ? parseStart(q.get("to")) : from + 7 * DAY;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return fail(422, "from and to must be UTC times (ISO 8601 with Z).");
    if (to - from > 14 * DAY) return fail(422, "At most 14 days per call.");
    const s = await slotsFor(app, ctx, type, from, to);
    if (s.paused) return json({ ok: true, paused: true, message: PAUSED, slots: [] });
    return json({ ok: true, type: type.id, minutes: type.minutes, timeZone: cfg.owner.timeZone, slots: s.slots.map((t) => new Date(t).toISOString()) });
  }
  if (name === "hold" && request.method === "POST") {
    const body = await readBody(request);
    if (!body) return fail(400, "Send a JSON body.");
    const type = cfg.types.get(String(body.type ?? ""));
    if (!type) return fail(404, "No such booking type.");
    if (!type.on) return fail(422, "This booking type isn't set up correctly.");
    const startMs = parseStart(body.start);
    if (!Number.isFinite(startMs)) return fail(422, "start must be a UTC time (ISO 8601 with Z).");
    const r = await takeHold(app, ctx, request, type, startMs, { via: "page", token: String(body.turnstile ?? "") });
    if (!r.ok) return json({ ok: false, error: r.error, code: r.code, ...(r.nearest ? { taken: true, nearest: r.nearest } : {}) }, r.status);
    return json({ ok: true, holdId: r.id, token: r.token, expiresAt: new Date(r.expiresAt).toISOString() });
  }
  if (name === "confirm" && request.method === "POST") {
    const body = await readBody(request);
    if (!body) return fail(400, "Send a JSON body.");
    const id = String(body.holdId ?? "");
    const b = isId("bk", id) ? await loadBooking(env, id) : null;
    if (!b) return fail(404, "No such hold.");
    const r = await finishBooking(app, ctx, b, { ...body, token: String(body.token ?? "") });
    if (!r.ok) return json({ ok: false, error: r.error, code: r.code, ...(r.errors ? { errors: r.errors } : {}), ...(r.code === "expired" ? { stillFree: r.stillFree, start: r.start } : {}) }, r.status);
    return json({
      ok: true,
      status: r.status,
      bookingId: r.booking.id,
      start: new Date(r.booking.start_ms).toISOString(),
      end: new Date(r.booking.end_ms).toISOString(),
      manageUrl: r.manageUrl,
      ...(r.status === "verify" ? { message: "Check your email and click the link to confirm, within 30 minutes." } : {}),
    });
  }
  return fail(405, "Not allowed.");
}

// --- The no-JavaScript path ---------------------------------------------

export async function noJsRoutes(request, app, ctx, path) {
  const { cfg, env } = app;
  if (!cfg.noJs || cfg.visitorEmail === "provider-confirm") {
    return html(problemPage("Please turn on JavaScript", "This booking page needs JavaScript."), 404);
  }
  const zone = cfg.owner.timeZone;
  const zoneName = zone.split("/").pop().replace(/_/g, " ");
  if (path === "/nojs" || path === "/nojs/") {
    const items = [...cfg.types.values()].filter((t) => t.on).map((t) => `<li><a href="/nojs/${e(t.id)}">${e(t.name)}</a> (${t.minutes} minutes)</li>`).join("");
    return html(layout(`Book a time with ${cfg.owner.name}`, `<h1>Book a time with ${e(cfg.owner.name)}</h1><ul>${items}</ul>`));
  }
  const m = /^\/nojs\/([a-z0-9][a-z0-9-]{0,39})\/?$/.exec(path);
  const type = m ? cfg.types.get(m[1]) : null;
  if (!type) return html(problemPage("Not found", "There's no booking type here."), 404);
  if (!type.on) return html(problemPage("Not available", "This booking type isn't set up correctly."), 422);
  if (setupProblem(env)) return html(problemPage("Not available", unavailable(app)), 503);
  const back = `/nojs/${type.id}`;

  if (request.method === "GET") {
    const week = Math.min(Math.max(Number.parseInt(new URL(request.url).searchParams.get("week") ?? "0", 10) || 0, 0), Math.ceil(type.horizonDays / 7));
    const now = app.now();
    const from = now + week * 7 * DAY;
    const s = await slotsFor(app, ctx, type, from, from + 7 * DAY);
    if (s.paused) return html(problemPage("Bookings paused", PAUSED), 503);
    const nav = `<p class="nav">${week > 0 ? `<a href="${back}?week=${week - 1}">Earlier</a> ` : ""}<a href="${back}?week=${week + 1}">Later</a></p>`;
    return html(layout(type.name, `<h1>${e(type.name)} with ${e(cfg.owner.name)}</h1>
<p>${type.minutes} minutes. Times in ${e(zoneName)} time.</p>
${type.description ? `<p>${e(type.description)}</p>` : ""}
<form method="post" action="${back}">
${timeRadios(s.slots, zone)}
${nav}
${detailFields(cfg, type)}
<button type="submit">Book</button>
</form>`));
  }
  if (request.method !== "POST") return html(problemPage("Not allowed", "Use the form."), 405);
  const body = await readBody(request);
  if (!body) return html(problemPage("Something went wrong", "The form couldn't be read.", back), 400);
  const startMs = Number(body.start);
  if (!Number.isFinite(startMs)) return html(problemPage("Choose a time", "Please pick one of the times.", back), 422);
  const h = await takeHold(app, ctx, request, type, startMs, { via: "nojs" });
  if (!h.ok) {
    const near = h.nearest?.length ? ` Nearest free times: ${h.nearest.map((t) => formatWhen(Date.parse(t), zone)).join("; ")}.` : "";
    return html(problemPage("That didn't work", `${h.error}${near}`, back), h.status);
  }
  const b = await loadBooking(env, h.id);
  const r = await finishBooking(app, ctx, b, { ...body, token: h.token, timeZone: zone });
  if (!r.ok) {
    // Don't leave the time held after a form error: release it at once.
    if (r.code === "fields" || r.code === "upcoming") await cancel(app, b, { by: "system", reason: "form error", now: app.now(), kind: "released" });
    const details = r.errors ? ` ${Object.values(r.errors).join(". ")}.` : "";
    return html(problemPage("That didn't work", `${r.error}${details}`, back), r.status);
  }
  return isFormPost(request) ? redirect(r.manageUrl) : json({ ok: true, manageUrl: r.manageUrl });
}

