// What each notification says. Everything a visitor typed is escaped in HTML
// and kept out of headers (the subject goes through RFC 2047 encoding with
// CR/LF removed; Reply-To is set only for one valid address). Emails to
// visitors use fixed text: your text, the time, the location and links; the
// visitor's own name is the only typed value shown (60 characters, links removed).
import { escapeHtml } from "./http.js";
import { formatWhen, isZone } from "./tz.js";
import { isEmail } from "./validate.js";
import { vevent, calendar } from "./ics-write.js";
import { manageUrl, approveUrl, verifyUrl } from "./links.js";

const MIN = 60_000;

export function locationText(cfg, b, forVisitor) {
  const loc = cfg.locations[b.location_key];
  const detail = b.location_detail ?? "";
  if (!loc) return detail;
  const label = loc.label ? `${loc.label}: ` : "";
  if (loc.kind === "video") return `${label || "Video call: "}${detail || (forVisitor ? "the link will follow" : "add a link (PATCH /api/bookings/:id)")}`;
  if (loc.kind === "in-person") return `${label || "In person: "}${detail}`;
  if (loc.who === "owner-number") return forVisitor ? `${label || "Phone: "}call ${detail}` : `${label || "Phone: "}they call you on ${detail}`;
  return forVisitor ? `${label || "Phone: "}${cfg.owner.name} will call you on ${b.phone ?? detail}` : `${label || "Phone: "}you call them on ${b.phone ?? detail}`;
}

/** The visitor's name as shown to them: 60 characters, nothing link-like. */
export function safeName(s) {
  return String(s ?? "")
    .replace(/(https?:\/\/|www\.)\S*/gi, "")
    .replace(/[\x00-\x1f\x7f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export function hostOf(app) {
  return app.host;
}

/** The .ics for a booking, from the owner's or the visitor's side. */
export function bookingIcs(app, b, { method, forVisitor, manage = "" }) {
  const { cfg } = app;
  const type = cfg.types.get(b.type_id);
  const typeName = type?.name ?? b.type_id;
  const cancelled = method === "CANCEL" || ["cancelled", "declined", "expired"].includes(b.status);
  const status = cancelled ? "CANCELLED" : ["requested", "approve_requested", "decline_requested"].includes(b.status) ? "TENTATIVE" : "CONFIRMED";
  const loc = locationText(cfg, b, forVisitor);
  const description = forVisitor
    ? [loc, manage ? `Change or cancel: ${manage}` : ""].filter(Boolean).join("\n")
    : [loc, `Booked by: ${b.name ?? ""} <${b.email ?? ""}>`, b.phone ? `Phone: ${b.phone}` : "", b.notes ? `Notes: ${b.notes}` : ""].filter(Boolean).join("\n");
  const ev = vevent({
    booking: b,
    host: app.host,
    summary: forVisitor ? `${typeName} with ${cfg.owner.name}` : `${typeName} with ${b.name ?? "(removed)"}`,
    description,
    location: loc,
    status,
    organizer: { name: cfg.owner.name, email: cfg.owner.email },
    attendee: b.email ? { name: forVisitor ? safeName(b.name) : b.name, email: b.email } : null,
    alarmMinutes: type?.reminders?.[0] ?? null,
    stamp: app.now(),
  });
  return calendar(method === "FEED" ? null : method, [ev]);
}

function page(lines, links = []) {
  const text = [...lines, "", ...links.map(([label, url]) => `${label}: ${url}`)].join("\n");
  const html =
    lines.map((l) => (l ? `<p>${escapeHtml(l).replace(/\n/g, "<br>")}</p>` : "")).join("") +
    links.map(([label, url]) => `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`).join("");
  return { text, html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${html}</div>` };
}

const REQUEST_KINDS = new Set(["owner_new", "owner_change", "visitor_confirm", "visitor_change"]);

/**
 * Builds one notification, or says why it isn't sent.
 * @returns {Promise<{ skip: string } | { toVisitor: boolean, to: string, subject: string, text: string, html: string, replyTo?: string, calendar?: object }>}
 */
export async function buildEmail(app, d, b) {
  const { cfg } = app;
  const now = app.now();
  if (d.kind === "owner_paused") {
    const p = page([
      "Bookings are paused: your calendar's ICS link hasn't been readable for over 24 hours, so free times can't be checked against it.",
      "Visitors see \"bookings are paused while the calendar can't be read\". It resumes by itself when the link works again.",
      "GET /api/calendar-check shows the error.",
    ]);
    return { toVisitor: false, to: cfg.owner.email, subject: "Bookings paused: your calendar link can't be read", ...p };
  }
  if (!b) return { skip: "the booking was deleted" };
  const type = cfg.types.get(b.type_id);
  const typeName = type?.name ?? b.type_id;
  const toVisitor = d.kind.startsWith("visitor_") || d.kind.startsWith("reminder_visitor_");
  if (toVisitor && (!b.email || b.anonymised_at)) return { skip: "no visitor address (removed)" };
  if (REQUEST_KINDS.has(d.kind) && d.sequence < b.sequence) return { skip: "superseded by a newer version" };
  const isReminder = d.kind.startsWith("reminder_");
  if (isReminder && now >= b.start_ms) return { skip: "the meeting had already started" };
  if ((isReminder || d.kind === "owner_new" || d.kind === "visitor_confirm") && !["confirmed", "cancel_requested"].includes(b.status)) {
    return { skip: `the booking is ${b.status}` };
  }
  if ((d.kind === "owner_request" || d.kind === "visitor_request") && !["requested", "approve_requested", "decline_requested"].includes(b.status)) {
    return { skip: `the booking is ${b.status}` };
  }
  if (d.kind === "visitor_verify" && !(b.status === "held" && b.verify_pending && b.hold_expires_at > now)) return { skip: "the hold isn't waiting any more" };

  const ownerZone = cfg.owner.timeZone;
  const vz = isZone(b.visitor_tz) ? b.visitor_tz : ownerZone;
  const whenOwner = formatWhen(b.start_ms, ownerZone);
  const whenVisitor = formatWhen(b.start_ms, vz);
  const mins = Math.round((b.end_ms - b.start_ms) / MIN);
  const who = b.name ?? "(name removed)";
  const vname = safeName(b.name) || "there";
  const replyTo = isEmail(b.email ?? "") ? b.email : undefined;
  const ownerIcs = (method) => ({ method, ics: bookingIcs(app, b, { method, forVisitor: false }), inline: cfg.ownerInvite !== "attach-only" });
  const ownerLines = () => [
    `${typeName} (${mins} minutes) with ${who}`,
    `When: ${whenOwner}${vz !== ownerZone ? ` (their time: ${whenVisitor})` : ""}`,
    `Where: ${locationText(cfg, b, false)}`,
    `Email: ${b.email ?? ""}`,
    ...(b.phone ? [`Phone: ${b.phone}`] : []),
    ...(b.notes ? [`Notes:\n${b.notes}`] : []),
  ];
  const owner = (subject, lines, links = [], cal) => ({ toVisitor: false, to: cfg.owner.email, subject, replyTo, ...page(lines, links), ...(cal ? { calendar: cal } : {}) });

  switch (d.kind) {
    case "owner_new":
      return owner(`New booking: ${typeName} with ${who}, ${whenOwner}`, ownerLines(), [], ownerIcs("REQUEST"));
    case "owner_change":
      return owner(`Booking changed: ${typeName} with ${who}, now ${whenOwner}`, ownerLines(), [], ownerIcs("REQUEST"));
    case "owner_cancel":
      return owner(
        `Booking cancelled: ${typeName} with ${who}, ${whenOwner}`,
        [...ownerLines(), `Cancelled by ${b.cancelled_by === "owner" ? "you" : b.cancelled_by === "visitor" ? "them" : "the system"}${b.cancel_reason ? `: ${b.cancel_reason}` : ""}`],
        [],
        ownerIcs("CANCEL"),
      );
    case "owner_request":
      return owner(
        `Booking request: ${typeName} with ${who}, ${whenOwner}`,
        [...ownerLines(), `This time is held for you until ${formatWhen(b.request_expires_at ?? b.start_ms, ownerZone)}. Approve or decline on the page below.`],
        [["Approve or decline", await approveUrl(app, b)]],
      );
    case "owner_expired":
      return owner(`Request expired: ${typeName} with ${who}, ${whenOwner}`, [...ownerLines(), "It wasn't approved in time, so the time is free again."]);
    default:
      break;
  }
  if (d.kind.startsWith("reminder_owner_")) {
    return owner(`Reminder: ${typeName} with ${who}, ${whenOwner}`, ownerLines());
  }

  // Emails to the visitor.
  const manage = await manageUrl(app, b);
  const visitorIcs = (method) => ({ method, ics: bookingIcs(app, b, { method, forVisitor: true, manage }) });
  const where = `Where: ${locationText(cfg, b, true)}`;
  const visitor = (subject, lines, links, cal) => ({ toVisitor: true, to: b.email, subject, ...page([`Hi ${vname},`, ...lines], links), ...(cal ? { calendar: cal } : {}) });
  const head = `${typeName} (${mins} minutes) with ${cfg.owner.name}`;
  switch (d.kind) {
    case "visitor_confirm":
      return visitor(`Booked: ${typeName} with ${cfg.owner.name}, ${whenVisitor}`, [`Your booking is confirmed.`, head, `When: ${whenVisitor}`, where], [["Change or cancel", manage]], visitorIcs("REQUEST"));
    case "visitor_change":
      return visitor(`Changed: ${typeName} with ${cfg.owner.name}, now ${whenVisitor}`, [`Your booking has changed.`, head, `When: ${whenVisitor}`, where], [["Change or cancel", manage]], visitorIcs("REQUEST"));
    case "visitor_cancel":
      return visitor(
        `Cancelled: ${typeName} with ${cfg.owner.name}, ${whenVisitor}`,
        [
          b.status === "declined" ? `${cfg.owner.name} couldn't accept this request.` : b.status === "expired" ? "This request wasn't approved in time." : "This booking is cancelled.",
          head,
          `When: ${whenVisitor}`,
        ],
        [],
        visitorIcs("CANCEL"),
      );
    case "visitor_request":
      return visitor(`Request sent: ${typeName} with ${cfg.owner.name}, ${whenVisitor}`, [`${cfg.owner.name} will approve or decline your request; you'll get an email either way.`, head, `When: ${whenVisitor}`], [["See or cancel your request", manage]]);
    case "visitor_verify":
      return visitor(
        `Confirm your booking: ${typeName} with ${cfg.owner.name}`,
        [`Please confirm this booking within 30 minutes, or the time is released.`, head, `When: ${whenVisitor}`, "If you didn't ask for this, ignore this email."],
        [["Confirm my booking", await verifyUrl(app, b)]],
      );
    default:
      break;
  }
  if (d.kind.startsWith("reminder_visitor_")) {
    return visitor(`Reminder: ${typeName} with ${cfg.owner.name}, ${whenVisitor}`, [head, `When: ${whenVisitor}`, where], [["Change or cancel", manage]]);
  }
  return { skip: `unknown kind ${d.kind}` };
}
