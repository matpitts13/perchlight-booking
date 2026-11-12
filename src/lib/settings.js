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

/**
 * Your calendar's private ICS links (a secret: anyone holding one can read
 * your calendar), comma-separated. Entries that can't be used are reported,
 * never silently dropped: dropping one would make you look free.
 * @returns {{ urls: string[], problems: string[] }}
 */
export function calendarUrls(env) {
  const raw = String(env.CALENDAR_ICS_URLS ?? "").trim();
  if (!raw) return { urls: [], problems: [] };
  const entries = raw.split(",").map((u) => u.trim().replace(/^["']|["']$/g, "").replace(/^webcal:/i, "https:")).filter(Boolean);
  const urls = [];
  let bad = 0;
  for (const u of entries) {
    // https only; plain http just for a feed on this machine (local testing with wrangler dev).
    if (/^https:\/\/\S+$/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*$/i.test(u)) urls.push(u);
    else bad++;
  }
  const problems = [];
  if (bad) problems.push(`CALENDAR_ICS_URLS has ${bad} entr${bad === 1 ? "y" : "ies"} that isn't an https:// (or webcal://) link; separate links with commas.`);
  if (urls.length > 5) problems.push(`CALENDAR_ICS_URLS has ${urls.length} links; at most 5 are read.`);
  if (problems.length) problems.push("Bookings are paused until it's fixed.");
  return { urls: urls.slice(0, 5), problems };
}