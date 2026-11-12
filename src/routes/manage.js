// Link-holder pages. A GET never changes anything (mail scanners open
// links); every change is a POST from a button on the page.
//   /b/:id?t=          manage: details, .ics, add-to-calendar, cancel, reschedule
//   /r/:id?t=          your approve / decline page
//   /v/:id?t=          "confirm your email" (provider-confirm mode)
import { html, json, redirect, readBody, isFormPost, escapeHtml as e } from "../lib/http.js";
import { verifyToken, manageUrl, inviteUrl } from "../lib/links.js";
import { loadBooking, cancel, reschedule, approve, verifyEmail } from "../lib/bookings.js";
import { ruleProblem, overlapsBusy, freeSlots } from "../lib/slots.js";
import { windowData } from "../lib/store.js";
import { freshBusy } from "../lib/busy.js";
import { bookingIcs, locationText } from "../lib/notify.js";
import { deliverBooking } from "../lib/deliveries.js";
import { scheduleNext } from "../lib/housekeeping.js";
import { isZone, formatWhen } from "../lib/tz.js";
import { isId } from "../lib/crypto.js";
import { oneLine } from "../lib/validate.js";
import { icsTime } from "../lib/ics-write.js";
import { spend, COST } from "../lib/budget.js";
import { layout, problemPage, timeRadios } from "./pages.js";
import { slotsFor, PAUSED } from "./public.js";

const MIN = 60_000;
const DAY = 86_400_000;
const BAD_LINK = () => html(problemPage("This link doesn't work", "It isn't valid, or it has expired."), 404);
const LIVE = new Set(["confirmed", "requested", "cancel_requested", "approve_requested", "decline_requested"]);

function after(app, ctx, id) {
  ctx.waitUntil(
    deliverBooking(app, id)
      .then(() => scheduleNext(app))
      .catch((err) => console.error(`notify ${id}: ${err instanceof Error ? err.message : String(err)}`)),
  );
}

function statusLine(b) {
  return {
    confirmed: "Booked.",
    requested: "Requested: waiting for approval.",
    approve_requested: "Requested: waiting for approval.",
    decline_requested: "Requested: waiting for approval.",
    cancel_requested: "Being cancelled.",
    cancelled: "Cancelled.",
    declined: "Declined: this request wasn't accepted.",
    expired: "Expired: this time was released.",
    held: b.verify_pending ? "Waiting for you to confirm by email." : "Held while you finish booking.",
  }[b.status];
}

function googleLink(b, title, details, location) {
  const q = new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${icsTime(b.start_ms)}/${icsTime(b.end_ms)}`, details, location });
  return `https://calendar.google.com/calendar/render?${q}`;
}
function outlookLink(b, title, details, location) {
  const q = new URLSearchParams({
    path: "/calendar/action/compose", rru: "addevent", subject: title,
    startdt: new Date(b.start_ms).toISOString(), enddt: new Date(b.end_ms).toISOString(), body: details, location,
  });
  return `https://outlook.live.com/calendar/0/action/compose?${q}`;
}

async function managePage(app, b, token, note = "") {
  const { cfg } = app;
  const type = cfg.types.get(b.type_id);
  const zone = isZone(b.visitor_tz) ? b.visitor_tz : cfg.owner.timeZone;
  const title = `${type?.name ?? b.type_id} with ${cfg.owner.name}`;
  const loc = locationText(cfg, b, true);
  const now = app.now();
  const live = LIVE.has(b.status);
  const canChange = live && b.start_ms > now;
  const self = await manageUrl(app, b);
  const t = e(token);
  const cancelledNote = cfg.visitorEmail === "none" ? "<p><small>If you added this to your calendar and cancel, remove it from your calendar too.</small></p>" : "";
  let body = `<h1>${e(title)}</h1>
${note ? `<p class="note">${e(note)}</p>` : ""}
<p><strong>${e(statusLine(b))}</strong></p>
<p>${e(formatWhen(b.start_ms, zone))}<br>${Math.round((b.end_ms - b.start_ms) / MIN)} minutes</p>
${live ? `<p>${e(loc)}</p>` : ""}
<p><small>Bookmark this page: it's how you change or cancel this booking.</small></p>`;
  if (live) {
    body += `<h2>Add to your calendar</h2>
<p><a href="${e(await inviteUrl(app, b))}">Download (.ics)</a> · <a href="${e(googleLink(b, title, `Change or cancel: ${self}`, loc))}" rel="noopener">Google Calendar</a> · <a href="${e(outlookLink(b, title, `Change or cancel: ${self}`, loc))}" rel="noopener">Outlook</a></p>${cancelledNote}`;
  }
  if (canChange) {
    body += `<h2>Change</h2>
<p><a href="/b/${e(b.id)}/reschedule?t=${t}">Pick a different time</a></p>
<form method="post" action="/b/${e(b.id)}/cancel">
<input type="hidden" name="t" value="${t}">
<label>Reason (optional) <input name="reason" maxlength="300"></label>
<button type="submit">Cancel this booking</button>
</form>`;
  }
  return html(layout(title, body));
}

export async function manageRoutes(request, app, ctx, path) {
  const m = /^\/([bvr])\/([a-z0-9_]{1,40})(?:\/(cancel|reschedule|invite\.ics|approve|decline))?\/?$/.exec(path);
  if (!m) return html(problemPage("Not found", "There's nothing here."), 404);
  const [, area, id, action = ""] = m;
  if (!isId("bk", id)) return BAD_LINK();
  const post = request.method === "POST";
  if (!post && request.method !== "GET") return html(problemPage("Not allowed", "Use the page's buttons."), 405);
  const body = post ? await readBody(request) : null;
  if (post && !body) return html(problemPage("Something went wrong", "The form couldn't be read."), 400);
  const token = String((post ? body.t : null) ?? new URL(request.url).searchParams.get("t") ?? "");
  spend(app.budget, COST.change);
  const b = await loadBooking(app.env, id);
  if (!b) return BAD_LINK();
  const now = app.now();
  const linkAction = area === "b" ? "manage" : area === "r" ? "approve" : "verify";
  if (!(await verifyToken(app.env, b.id, linkAction, b.manage_version, token, now))) return BAD_LINK();
  const wantsJson = post && !isFormPost(request);
  const answer = async (note, status = 200, booking = b) => {
    if (wantsJson) return json({ ok: status < 400, message: note, status: booking.status }, status);
    return area === "r" ? approvePage(app, booking, token, note, status) : managePage(app, booking, area === "b" ? token : "", note);
  };

  if (area === "b") {
    if (action === "invite.ics" && !post) {
      const method = LIVE.has(b.status) ? "PUBLISH" : "CANCEL";
      return new Response(bookingIcs(app, b, { method, forVisitor: true, manage: await manageUrl(app, b) }), {
        headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="booking.ics"', "Cache-Control": "private, no-store" },
      });
    }
    if (!action && !post) return managePage(app, b, token);
    if (action === "cancel" && post) {
      if (!LIVE.has(b.status)) return answer("This booking was already cancelled or finished.", 409);
      if (b.start_ms <= now) return answer("This meeting has already started.", 409);
      const r = await cancel(app, b, { by: "visitor", reason: oneLine(body.reason, 300) || null, now });
      if (!r.ok) return answer(r.error === "db" ? "Cancelling isn't possible right now. Please try again." : "This booking changed meanwhile; please look again.", r.error === "db" ? 503 : 409);
      after(app, ctx, b.id);
      return answer("Cancelled. You don't need to do anything else.", 200, r.booking);
    }
    if (action === "reschedule") {
      const type = app.cfg.types.get(b.type_id);
      if (!type || !type.on) return answer("This booking type can't be changed online any more.", 422);
      if (!["confirmed", "requested"].includes(b.status) || b.start_ms <= now) return answer("This booking can't be moved.", 409);
      if (!post) return reschedulePage(app, ctx, b, type, token, request);
      const startMs = Number(body.start);
      const ex = (await windowData(app, startMs - DAY, startMs + DAY, now)).exceptions;
      const rule = Number.isFinite(startMs) ? ruleProblem(app.cfg, type, startMs, now, ex) : "Please pick one of the times.";
      if (rule) return answer(rule, 422);
      const busy = await freshBusy(app, ctx, now, "hold");
      if (busy.paused) return answer(PAUSED, 503);
      if (overlapsBusy(busy.intervals, startMs / MIN - type.bufferAfter, startMs / MIN + type.minutes + type.bufferAfter)) return answer("That time was just taken. Please pick another.", 409);
      const r = await reschedule(app, b, type, startMs, now);
      if (!r.ok) {
        const msg = { taken: "That time was just taken. Please pick another.", full: "That day is full. Please pick another.", changed: "This booking changed meanwhile; please look again." }[r.error];
        return answer(msg ?? "Moving isn't possible right now; nothing was changed.", msg ? 409 : 503);
      }
      after(app, ctx, b.id);
      const url = await manageUrl(app, r.booking);
      if (wantsJson) return json({ ok: true, manageUrl: url, start: new Date(startMs).toISOString() });
      return redirect(url);
    }
  }

  if (area === "r") {
    if (!post) return approvePage(app, b, token);
    if (!["requested", "approve_requested", "decline_requested"].includes(b.status)) return answer(`This request is ${b.status} already.`, 409);
    if (action === "approve") {
      const link = oneLine(body.link, 500);
      if (link && !/^https:\/\/\S+$/.test(link)) return answer("The video link must start with https://", 422);
      const r = await approve(app, b, { link: link || null, now });
      if (!r.ok) return answer(r.error === "db" ? "Approving isn't possible right now. Please try again." : "This request expired or changed meanwhile.", r.error === "db" ? 503 : 409);
      after(app, ctx, b.id);
      return answer("Approved. The invite is on its way.", 200, r.booking);
    }
    if (action === "decline") {
      const r = await cancel(app, b, { by: "owner", reason: oneLine(body.reason, 300) || null, now, kind: "declined" });
      if (!r.ok) return answer(r.error === "db" ? "Declining isn't possible right now. Please try again." : "This request expired or changed meanwhile.", r.error === "db" ? 503 : 409);
      after(app, ctx, b.id);
      return answer("Declined. The time is free again.", 200, r.booking);
    }
  }

  if (area === "v") {
    const type = app.cfg.types.get(b.type_id);
    if (!post) {
      if (!(b.status === "held" && b.verify_pending)) return managePage(app, b, "", "This booking was already confirmed or has expired.");
      return html(layout("Confirm your booking", `<h1>Confirm your booking</h1><p>${e(type?.name ?? "")} with ${e(app.cfg.owner.name)}, ${e(formatWhen(b.start_ms, isZone(b.visitor_tz) ? b.visitor_tz : app.cfg.owner.timeZone))}</p>
<form method="post" action="/v/${e(b.id)}"><input type="hidden" name="t" value="${e(token)}"><button type="submit">Confirm my booking</button></form>`));
    }
    if (!type) return html(problemPage("Not available", "This booking type isn't set up any more."), 422);
    const r = await verifyEmail(app, b, type, now);
    if (!r.ok) return html(problemPage("Too late", r.error === "db" ? "Confirming isn't possible right now. Please try again." : "This hold ran out or was already confirmed."), r.error === "db" ? 503 : 409);
    after(app, ctx, b.id);
    return redirect(await manageUrl(app, r.booking));
  }
  return html(problemPage("Not found", "There's nothing here."), 404);
}

async function reschedulePage(app, ctx, b, type, token, request) {
  const zone = isZone(b.visitor_tz) ? b.visitor_tz : app.cfg.owner.timeZone;
  const week = Math.min(Math.max(Number.parseInt(new URL(request.url).searchParams.get("week") ?? "0", 10) || 0, 0), Math.ceil(type.horizonDays / 7));
  const from = app.now() + week * 7 * DAY;
  const s = await slotsFor(app, ctx, type, from, from + 7 * DAY);
  if (s.paused) return html(problemPage("Bookings paused", PAUSED), 503);
  // Its own cells and its own place in the day's count don't block it.
  const cells = new Set(s.w.cells);
  for (let c = b.start_ms; c < b.claim_end_ms; c += type.cell * MIN) cells.delete(c);
  const counts = new Map(s.w.counts);
  for (const k of [`${b.local_day}|${b.type_id}`, `${b.local_day}|*`]) if (counts.has(k)) counts.set(k, counts.get(k) - 1);
  const slots = freeSlots(app.cfg, type, { fromMs: from, toMs: from + 7 * DAY, now: app.now(), busy: s.busy.intervals, exceptions: s.w.exceptions, cells, counts });
  const t = e(token);
  const base = `/b/${e(b.id)}/reschedule?t=${t}`;
  return html(layout("Pick a different time", `<h1>Pick a different time</h1>
<p>Now: ${e(formatWhen(b.start_ms, zone))}. Times below in ${e(zone.replace(/_/g, " "))} time.</p>
<form method="post" action="/b/${e(b.id)}/reschedule">
<input type="hidden" name="t" value="${t}">
${timeRadios(slots.filter((x) => x !== b.start_ms), zone)}
<p class="nav">${week > 0 ? `<a href="${base}&week=${week - 1}">Earlier</a> ` : ""}<a href="${base}&week=${week + 1}">Later</a></p>
<button type="submit">Move my booking</button>
</form>`));
}

async function approvePage(app, b, token, note = "", status = 200) {
  const { cfg } = app;
  const type = cfg.types.get(b.type_id);
  const zone = cfg.owner.timeZone;
  const waiting = ["requested", "approve_requested", "decline_requested"].includes(b.status);
  const loc = cfg.locations[b.location_key];
  const t = e(token);
  let body = `<h1>Booking request</h1>${note ? `<p class="note">${e(note)}</p>` : ""}
<p><strong>${e(type?.name ?? b.type_id)}</strong> with ${e(b.name ?? "")} &lt;${e(b.email ?? "")}&gt;</p>
<p>${e(formatWhen(b.start_ms, zone))}</p>
<p>${e(locationText(cfg, b, false))}</p>
${b.phone ? `<p>Phone: ${e(b.phone)}</p>` : ""}${b.notes ? `<p>Notes: ${e(b.notes)}</p>` : ""}
<p>Status: ${e(b.status)}</p>`;
  if (waiting) {
    body += `<form method="post" action="/r/${e(b.id)}/approve"><input type="hidden" name="t" value="${t}">
${loc?.kind === "video" ? `<label>Video link for this booking (optional) <input name="link" type="url" maxlength="500" placeholder="https://"></label>` : ""}
<button type="submit">Approve</button></form>
<form method="post" action="/r/${e(b.id)}/decline"><input type="hidden" name="t" value="${t}">
<label>Reason (optional, for your records) <input name="reason" maxlength="300"></label>
<button type="submit">Decline</button></form>`;
  }
  return html(layout("Booking request", body), status);
}

