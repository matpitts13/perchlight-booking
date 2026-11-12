// Server-rendered pages: the no-JavaScript booking path, the manage page
// (confirmation, cancel, reschedule), the approve page, "confirm your email"
// and problem pages. Every value is escaped. No cookies, no scripts here.
import { escapeHtml as e } from "../lib/http.js";
import { formatWhen, formatTime, localDate, offsetLabel } from "../lib/tz.js";

export function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(title)}</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export function problemPage(heading, message, back = null) {
  return layout(heading, `<h1>${e(heading)}</h1><p>${e(message)}</p>${back ? `<p><a href="${e(back)}">Go back</a></p>` : ""}`);
}

const dayLabel = new Map();
function dayHeading(ms, zone) {
  const key = zone;
  let f = dayLabel.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long", day: "numeric", month: "long" });
    dayLabel.set(key, f);
  }
  return f.format(new Date(ms));
}

/** Times grouped by local day as radio buttons (no JavaScript needed). */
export function timeRadios(slots, zone, name = "start") {
  if (!slots.length) return "<p>No free times in these days.</p>";
  const days = new Map();
  for (const t of slots) {
    const d = localDate(zone, t);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(t);
  }
  let out = "";
  let first = true;
  for (const list of days.values()) {
    out += `<fieldset class="day"><legend>${e(dayHeading(list[0], zone))}</legend>`;
    for (const t of list) {
      const id = `t${t}`;
      out += `<label class="slot" for="${id}"><input type="radio" id="${id}" name="${name}" value="${t}"${first ? " required" : ""}> ${e(formatTime(t, zone))} <small>${e(offsetLabel(zone, t))}</small></label>`;
      first = false;
    }
    out += "</fieldset>";
  }
  return out;
}

export function detailFields(cfg, type, values = {}, errors = {}) {
  const err = (k) => (errors[k] ? `<span class="err" id="${k}-err">${e(errors[k])}</span>` : "");
  const v = (k) => e(values[k] ?? "");
  const locs = type.locations.map((k) => cfg.locations[k]).filter(Boolean);
  const locLabel = (l) => (l.label || { video: "Video call", phone: l.who === "owner-number" ? "Phone (you call)" : "Phone (we call you)", "in-person": "In person" }[l.kind]);
  let out = `<label>Name <input name="name" required maxlength="100" autocomplete="name" value="${v("name")}"></label>${err("name")}
<label>Email <input name="email" type="email" required maxlength="254" autocomplete="email" value="${v("email")}"></label>${err("email")}`;
  if (cfg.questions.phone !== "off" || locs.some((l) => l.kind === "phone" && l.who !== "owner-number")) {
    out += `<label>Phone${cfg.questions.phone === "required" ? "" : " (optional, needed if we call you)"} <input name="phone" type="tel" maxlength="30" autocomplete="tel" value="${v("phone")}"></label>${err("phone")}`;
  }
  if (cfg.questions.notes !== "off") out += `<label>Notes${cfg.questions.notes === "required" ? "" : " (optional)"} <textarea name="notes" maxlength="2000" rows="3">${v("notes")}</textarea></label>${err("notes")}`;
  if (locs.length > 1) {
    out += `<fieldset><legend>Where</legend>${locs.map((l, i) => `<label><input type="radio" name="location" value="${e(l.key)}"${(values.location ? values.location === l.key : i === 0) ? " checked" : ""}> ${e(locLabel(l))}</label>`).join("")}</fieldset>${err("location")}`;
  } else if (locs[0]) out += `<input type="hidden" name="location" value="${e(locs[0].key)}"><p>Where: ${e(locLabel(locs[0]))}</p>`;
  // Honeypot: real people never see or fill it.
  out += `<div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>`;
  return out;
}

export function when(b, zone) {
  return formatWhen(b.start_ms, zone);
}
