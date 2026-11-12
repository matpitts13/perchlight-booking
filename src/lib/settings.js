// Global settings from wrangler.jsonc "vars", read in one place with defaults
// (same shape as perchlight-forms src/lib/settings.js). Secrets are read where used.

/** @param {Record<string, unknown>} env */
export function settings(env) {
  return {
    publicUrl: str(env.PUBLIC_URL).replace(/\/+$/, ""),
    mailFrom: str(env.MAIL_FROM),
    feedMinutes: int(env.FEED_MINUTES, 10, 1),
    feedMaxKb: int(env.FEED_MAX_KB, 512, 16),
    retentionDays: int(env.RETENTION_DAYS, 90, 0), // after the meeting; 0 = keep until deleted
    fallbackContact: str(env.FALLBACK_CONTACT),
    housekeepingMinutes: int(env.HOUSEKEEPING_MINUTES, 5, 1),
    turnstileSiteKey: str(env.TURNSTILE_SITE_KEY),
  };
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/** A whole number >= min from a setting, or the fallback if it isn't one. */
function int(v, fallback, min) {
  const s = typeof v === "number" ? String(v) : str(v);
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number.parseInt(s, 10);
  return n >= min ? n : fallback;
}

/** Secrets that must be 16+ characters to be used at all. */
export function secretOk(env, name) {
  return String(env[name] ?? "").length >= 16;
}

/** Your calendar's private ICS links (a secret: anyone holding one can read your calendar). */
export function calendarUrls(env) {
  return String(env.CALENDAR_ICS_URLS ?? "")
    .split(/[,\s]+/)
    .map((u) => u.trim().replace(/^webcal:/i, "https:"))
    // https only; plain http just for a feed on this machine (local testing with wrangler dev).
    .filter((u) => /^https:\/\/\S+$/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*$/i.test(u))
    .slice(0, 5);
}
