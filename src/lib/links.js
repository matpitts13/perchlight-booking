// Signed, expiring links that need no account (pattern from perchlight-forms
// src/lib/links.js): t=<exp>.<HMAC(LINK_SECRET, "id.action.exp.manage_version")>.
// Rotating LINK_SECRET, or bumping a booking's manage_version, revokes them.
//   manage  (/b/:id)  cancel, reschedule, .ics: until the meeting ends + 7 days
//   approve (/r/:id)  your approve / decline page: until the request expires
//   verify  (/v/:id)  "confirm your email": until the hold expires
import { hmacHex, safeEqual } from "./crypto.js";
import { secretOk } from "./settings.js";

const DAY = 86_400_000;

export function linkSecretOk(env) {
  return secretOk(env, "LINK_SECRET");
}

export async function signToken(env, id, action, version, expMs) {
  const exp = Math.floor(expMs / 1000);
  const sig = await hmacHex(env.LINK_SECRET, `${id}.${action}.${exp}.${version}`);
  return `${exp}.${sig}`;
}

/** True only for an unexpired token whose signature matches (constant-time). */
export async function verifyToken(env, id, action, version, token, now = Date.now()) {
  if (!linkSecretOk(env)) return false;
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(String(token ?? ""));
  if (!m) return false;
  const expected = await hmacHex(env.LINK_SECRET, `${id}.${action}.${m[1]}.${version}`);
  const ok = await safeEqual(expected, m[2]);
  return ok && Number(m[1]) * 1000 > now;
}

export function manageExpiry(b) {
  return b.end_ms + 7 * DAY;
}

export async function manageUrl(app, b) {
  return `${app.base}/b/${b.id}?t=${await signToken(app.env, b.id, "manage", b.manage_version, manageExpiry(b))}`;
}

export async function approveUrl(app, b) {
  return `${app.base}/r/${b.id}?t=${await signToken(app.env, b.id, "approve", b.manage_version, b.request_expires_at ?? b.start_ms)}`;
}

export async function verifyUrl(app, b) {
  return `${app.base}/v/${b.id}?t=${await signToken(app.env, b.id, "verify", b.manage_version, b.hold_expires_at)}`;
}

export async function inviteUrl(app, b) {
  return `${app.base}/b/${b.id}/invite.ics?t=${await signToken(app.env, b.id, "manage", b.manage_version, manageExpiry(b))}`;
}
