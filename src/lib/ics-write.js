// Calendar invites and the bookings feed (RFC 5545 / iTIP RFC 5546).
// One UID per booking for its whole life; SEQUENCE grows with every change;
// METHOD:REQUEST for new and changed bookings, METHOD:CANCEL (with
// STATUS:CANCELLED) for cancellations, METHOD:PUBLISH for the visitor's
// download (no reply expected), no METHOD in the subscription feed.
// Times are UTC (...Z), so no VTIMEZONE is needed.
import { isEmail } from "./validate.js";

const enc = new TextEncoder();

/** TEXT value escaping (§3.3.11). */
export function icsText(s) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** A parameter value (CN=...): quoted, without quotes or control characters. */
function paramValue(s) {
  return `"${String(s ?? "").replace(/[\x00-\x1f\x7f"]/g, "").slice(0, 100)}"`;
}

/** Folds a content line at 75 octets, never splitting a character (§3.1). */
export function fold(line) {
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length ? 74 : 75; // continuation lines start with a space
    if (bytes + n > limit) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function icsTime(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function lines(list) {
  return list.map(fold).join("\r\n") + "\r\n";
}

/**
 * One VEVENT for a booking.
 * @param {object} o { booking, host, summary, description, location, status, organizer: {name,email}, attendee: {name,email}|null, alarmMinutes, stamp }
 */
export function vevent(o) {
  const b = o.booking;
  const out = [
    "BEGIN:VEVENT",
    `UID:${b.id}@${o.host}`,
    `SEQUENCE:${b.sequence}`,
    `DTSTAMP:${icsTime(o.stamp)}`,
    `DTSTART:${icsTime(b.start_ms)}`,
    `DTEND:${icsTime(b.end_ms)}`,
    `SUMMARY:${icsText(o.summary)}`,
  ];
  if (o.location) out.push(`LOCATION:${icsText(o.location)}`);
  if (o.description) out.push(`DESCRIPTION:${icsText(o.description)}`);
  out.push(`STATUS:${o.status}`);
  if (o.organizer && isEmail(o.organizer.email)) out.push(`ORGANIZER;CN=${paramValue(o.organizer.name)}:mailto:${o.organizer.email}`);
  if (o.attendee && isEmail(o.attendee.email)) {
    out.push(`ATTENDEE;CN=${paramValue(o.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${o.attendee.email}`);
  }
  if (o.status !== "CANCELLED") out.push("TRANSP:OPAQUE");
  if (o.alarmMinutes && o.status !== "CANCELLED") {
    out.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(o.summary)}`, `TRIGGER:-PT${Math.floor(o.alarmMinutes)}M`, "END:VALARM");
  }
  out.push("END:VEVENT");
  return out;
}

/** A whole calendar. method: "REQUEST" | "CANCEL" | "PUBLISH" | null (feed). */
export function calendar(method, events, name) {
  return lines([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Perchlight//perchlight-booking 0.1//EN",
    "CALSCALE:GREGORIAN",
    ...(method ? [`METHOD:${method}`] : []),
    ...(name ? [`X-WR-CALNAME:${icsText(name)}`] : []),
    ...events.flat(),
    "END:VCALENDAR",
  ]);
}
