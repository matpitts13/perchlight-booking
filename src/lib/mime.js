// Raw MIME for the send_email binding. Adapted from perchlight-forms
// src/lib/mime.js: adds a calendar invite, as
//   multipart/mixed
//     multipart/alternative: text/plain, text/html, text/calendar; method=...
//     attachment invite.ics (the same calendar)
// which is the shape Gmail and Outlook recognise as an invite.
// Header safety: every header value has CR/LF removed, non-ASCII header text
// is RFC 2047 encoded, and bodies are base64, so nothing a visitor typed can
// start a new header or a new MIME part.

const enc = new TextEncoder();

export function b64(s) {
  let bin = "";
  for (const b of enc.encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Removes line breaks and other control characters from a header value. */
export function headerSafe(s) {
  return String(s ?? "").replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ").trim();
}

/** RFC 2047 encoded-words, only when the text isn't plain ASCII. Each word
 *  stays under the 75-character limit; characters are never split. */
export function encodeHeader(s) {
  const clean = headerSafe(s);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words = [];
  let chunk = "";
  for (const ch of clean) {
    if (enc.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
}

/** "Name <a@b>" or "a@b" -> "a@b". */
export function addressOnly(a) {
  const m = /<([^>]+)>/.exec(String(a));
  return (m ? m[1] : String(a)).trim();
}

/** An address header value with an optional display name, made safe. */
function addressHeader(a) {
  const s = headerSafe(a);
  const m = /^(.*?)\s*<([^<>\s]+)>$/.exec(s);
  if (!m) return s;
  const name = m[1].replace(/^"|"$/g, "").trim();
  if (!name) return `<${m[2]}>`;
  const shown = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "")}"` : encodeHeader(name);
  return `${shown} <${m[2]}>`;
}

function body64(text) {
  return b64(text.replace(/\r?\n/g, "\r\n")).replace(/.{76}(?=.)/g, "$&\r\n");
}

function part(type, text, extra = []) {
  return [`Content-Type: ${type}; charset=utf-8`, ...extra, "Content-Transfer-Encoding: base64", "", body64(text)].join("\r\n");
}

const METHODS = new Set(["REQUEST", "CANCEL", "PUBLISH"]);

/**
 * A text + HTML email as raw MIME, optionally with a calendar invite.
 * calendar: { method: "REQUEST" | "CANCEL" | "PUBLISH", ics: string, inline?: boolean }
 */
export function mime({ from, to, replyTo, subject, text, html, calendar }) {
  const domain = addressOnly(from).split("@")[1] ?? "localhost";
  const alt = `=_pl_a${crypto.randomUUID().replace(/-/g, "")}`;
  const headers = [
    `From: ${addressHeader(from)}`,
    `To: ${addressHeader(to)}`,
    ...(replyTo ? [`Reply-To: ${addressHeader(replyTo)}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${headerSafe(domain)}>`,
    "MIME-Version: 1.0",
  ];
  const altParts = [`--${alt}`, part("text/plain", text), `--${alt}`, part("text/html", html ?? "")];
  if (!calendar) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`, "", ...altParts, `--${alt}--`, ""].join("\r\n");
  }
  const method = METHODS.has(calendar.method) ? calendar.method : "PUBLISH";
  if (calendar.inline !== false) altParts.push(`--${alt}`, part(`text/calendar; method=${method}`, calendar.ics));
  const mixed = `=_pl_m${crypto.randomUUID().replace(/-/g, "")}`;
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    ...altParts,
    `--${alt}--`,
    `--${mixed}`,
    part("application/ics", calendar.ics, ['Content-Disposition: attachment; filename="invite.ics"']).replace(
      "Content-Type: application/ics; charset=utf-8",
      'Content-Type: application/ics; charset=utf-8; name="invite.ics"',
    ),
    `--${mixed}--`,
    "",
  ].join("\r\n");
}

/** The calendar as an attachment, for the email services' JSON APIs. */
export function icsAttachment(calendar) {
  if (!calendar) return [];
  const method = METHODS.has(calendar.method) ? calendar.method : "PUBLISH";
  return [{ filename: "invite.ics", content: calendar.ics, contentType: `text/calendar; method=${method}; charset=utf-8` }];
}
