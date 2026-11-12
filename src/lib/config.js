// booking.json, checked once per isolate (and by `npm test` / `npm run check`).
// A mistake in one event type switches that type off (its page says so and
// GET /api/config names the mistake); the others keep working. A mistake in
// the owner block switches every type off.
import { isZone, WEEKDAYS } from "./tz.js";
import { isEmail } from "./validate.js";

export const STEPS = [5, 10, 15, 20, 30, 60];
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Paths the Worker or the static pages use: not usable as an event type slug.
const RESERVED = new Set(["api", "b", "r", "v", "feed", "tick", "nojs", "assets", "book", "index", "styles", "favicon", "robots"]);
const LOCATION_KINDS = new Set(["video", "phone", "in-person"]);
const VISITOR_EMAIL = new Set(["none", "provider", "provider-confirm"]);

export const DEFAULTS = {
  minNoticeHours: 4,
  horizonDays: 60,
  bufferAfterMinutes: 15,
  stepMinutes: 15,
  holdMinutes: 10,
  requestHours: 48,
  reminders: [1440, 60],
};

export const LIMIT_DEFAULTS = {
  holdsPerHour: 10, // per network (daily-keyed hash), JavaScript page
  noJsPerHour: 2, // per network, the no-JavaScript form (no Turnstile there)
  activeHoldsPerNetwork: 2,
  activeHolds: 20, // whole deployment
  upcomingPerEmail: 3,
  visitorEmailsPerAddressPerDay: 2, // confirmation / confirm-your-email emails
  visitorEmailsPerDay: 50, // all visitor emails, whole deployment
};

/** Cells are 15 minutes (5 for 5- and 10-minute grids). Every zone's offset
 *  is a multiple of 15 minutes, so local grid times always land on a cell. */
export function cellMinutes(step) {
  return step % 15 === 0 ? 15 : 5;
}

function hm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/.exec(String(s));
  if (!m) return null;
  return s === "24:00" ? 1440 : +m[1] * 60 + +m[2];
}

/** [["09:00","12:00"], ...] -> [[540, 720], ...] sorted, or an error string. */
export function parseRanges(list, cell, where) {
  if (!Array.isArray(list)) return `${where} must be a list of ["HH:MM", "HH:MM"] ranges`;
  const out = [];
  for (const r of list) {
    if (!Array.isArray(r) || r.length !== 2) return `${where}: each range is ["HH:MM", "HH:MM"]`;
    const a = hm(r[0]);
    const b = hm(r[1]);
    if (a === null || b === null) return `${where}: "${r[0]}"–"${r[1]}" isn't a 24-hour time range`;
    if (b <= a) return `${where}: ${r[0]}–${r[1]} ends before it starts`;
    if (a % cell || b % cell) return `${where}: ${r[0]}–${r[1]} must be on the ${cell}-minute grid`;
    out.push([a, b]);
  }
  out.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < out.length; i++) if (out[i][0] < out[i - 1][1]) return `${where}: ranges overlap`;
  return out;
}

/** Overlap of two sorted range lists. */
export function intersectRanges(a, b) {
  const out = [];
  for (const [s1, e1] of a) for (const [s2, e2] of b) {
    const s = Math.max(s1, s2);
    const e = Math.min(e1, e2);
    if (e > s) out.push([s, e]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

function int(v, fallback, min, max) {
  if (v === undefined) return { v: fallback };
  if (!Number.isInteger(v) || v < min || v > max) return { err: `must be a whole number from ${min} to ${max}` };
  return { v };
}

/**
 * @returns {{ ok: boolean, errors: string[], owner, defaults, limits, locations, types: Map<string, object>,
 *   visitorEmail: string, noJs: boolean, allDayEvents: string, retentionMode: string, ownerInvite: string, questions }}
 */
export function checkConfig(raw) {
  const errors = [];
  const c = raw && typeof raw === "object" ? raw : {};
  const owner = c.owner ?? {};
  const ownerErrors = [];
  if (!owner.name || typeof owner.name !== "string") ownerErrors.push("owner.name is required");
  if (!isEmail(owner.email)) ownerErrors.push("owner.email must be one email address (verified in Email Routing)");
  if (!isZone(owner.timeZone)) ownerErrors.push(`owner.timeZone "${owner.timeZone}" isn't an IANA time zone (for example Europe/London)`);

  const d = { ...DEFAULTS, ...(c.defaults ?? {}) };
  const step = d.stepMinutes;
  if (!STEPS.includes(step)) ownerErrors.push(`defaults.stepMinutes must be one of ${STEPS.join(", ")}`);
  const cell = cellMinutes(STEPS.includes(step) ? step : 15);

  const weekly = {};
  for (const wd of WEEKDAYS) {
    const r = parseRanges(owner.weekly?.[wd] ?? [], cell, `owner.weekly.${wd}`);
    if (typeof r === "string") ownerErrors.push(r);
    else weekly[wd] = r;
  }
  for (const k of Object.keys(owner.weekly ?? {})) if (!WEEKDAYS.includes(k)) ownerErrors.push(`owner.weekly.${k}: use mon, tue, wed, thu, fri, sat, sun`);
  const holidays = new Set();
  for (const h of owner.holidays ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) ownerErrors.push(`owner.holidays: "${h}" isn't a YYYY-MM-DD date`);
    else holidays.add(h);
  }
  const holidayFeeds = [];
  for (const u of owner.holidayFeeds ?? []) {
    if (!/^(https|webcal):\/\/\S+$/.test(u)) ownerErrors.push(`owner.holidayFeeds: "${String(u).slice(0, 60)}" isn't an https:// or webcal:// link`);
    else holidayFeeds.push(u.replace(/^webcal:/, "https:"));
  }
  const ownerCap = owner.dailyCap === undefined ? null : int(owner.dailyCap, null, 1, 1000);
  if (ownerCap?.err) ownerErrors.push(`owner.dailyCap ${ownerCap.err}`);

  const limits = { ...LIMIT_DEFAULTS };
  for (const [k, v] of Object.entries(c.limits ?? {})) {
    if (!(k in LIMIT_DEFAULTS)) errors.push(`limits.${k} isn't a setting`);
    else if (!Number.isInteger(v) || v < 0 || v > 100000) errors.push(`limits.${k} must be a whole number`);
    else limits[k] = v;
  }

  const visitorEmail = c.visitorEmail ?? "none";
  if (!VISITOR_EMAIL.has(visitorEmail)) errors.push(`visitorEmail must be "none", "provider" or "provider-confirm"`);

  const questions = { phone: "optional", notes: "optional", ...(c.questions ?? {}) };
  for (const [k, v] of Object.entries(questions)) {
    if (!["phone", "notes"].includes(k)) errors.push(`questions.${k}: only phone and notes can be set (name and email are always asked)`);
    else if (!["optional", "required", "off"].includes(v)) errors.push(`questions.${k} must be "optional", "required" or "off"`);
  }

  const locations = {};
  for (const [key, l] of Object.entries(c.locations ?? {})) {
    if (!SLUG.test(key) || !l || !LOCATION_KINDS.has(l.kind)) {
      errors.push(`locations.${key}: needs "kind": "video", "phone" or "in-person"`);
      continue;
    }
    if (l.kind === "video" && l.link !== undefined && !/^https:\/\/\S+$/.test(l.link)) errors.push(`locations.${key}.link must be an https:// link`);
    if (l.kind === "phone" && !["visitor-gives-number", "owner-number"].includes(l.who ?? "visitor-gives-number")) errors.push(`locations.${key}.who must be "visitor-gives-number" or "owner-number"`);
    if (l.kind === "phone" && l.who === "owner-number" && !/^[+0-9 ().-]{5,30}$/.test(l.number ?? "")) errors.push(`locations.${key}.number is needed for "owner-number"`);
    if (l.kind === "in-person" && !l.address) errors.push(`locations.${key}.address is required`);
    if (l.map !== undefined && !/^https:\/\/\S+$/.test(l.map)) errors.push(`locations.${key}.map must be an https:// link`);
    locations[key] = { key, kind: l.kind, link: l.link ?? "", who: l.who ?? "visitor-gives-number", number: l.number ?? "", address: l.address ?? "", map: l.map ?? "", label: l.label ?? "" };
  }

  const types = new Map();
  for (const [id, t] of Object.entries(c.types ?? {})) {
    const errs = [];
    if (!SLUG.test(id) || RESERVED.has(id)) errs.push(`"${id}" can't be an event type id (lower-case letters, digits, dashes; not ${[...RESERVED].join(", ")})`);
    const x = t && typeof t === "object" ? t : {};
    const num = (k, fb, min, max) => {
      const r = int(x[k], fb, min, max);
      if (r.err) errs.push(`${k} ${r.err}`);
      return r.v ?? fb;
    };
    const minutes = num("minutes", undefined, 5, 720);
    if (x.minutes === undefined) errs.push("minutes is required");
    const bufferAfter = num("bufferAfterMinutes", d.bufferAfterMinutes, 0, 240);
    const minNoticeHours = num("minNoticeHours", d.minNoticeHours, 0, 24 * 90);
    const horizonDays = num("horizonDays", d.horizonDays, 1, 365);
    const holdMinutes = num("holdMinutes", d.holdMinutes, 2, 60);
    const requestHours = num("requestHours", d.requestHours, 1, 24 * 14);
    const dailyCap = x.dailyCap === undefined ? null : num("dailyCap", null, 1, 1000);
    if (minutes && minutes % cell) errs.push(`minutes must be a multiple of ${cell} (the slot grid's cells)`);
    if (bufferAfter % cell) errs.push(`bufferAfterMinutes must be a multiple of ${cell}`);
    const reminders = x.reminders ?? d.reminders;
    if (!Array.isArray(reminders) || reminders.length > 3 || reminders.some((m) => !Number.isInteger(m) || m < 5 || m > 10080)) errs.push("reminders must be up to 3 whole numbers of minutes (5 to 10080)");
    const locs = x.locations ?? Object.keys(locations).slice(0, 1);
    if (!Array.isArray(locs) || !locs.length) errs.push("locations must list at least one key from \"locations\"");
    else for (const l of locs) if (!locations[l]) errs.push(`location "${l}" isn't in "locations"`);
    // A type's own weekly hours only narrow the owner's (the overlap is used).
    let typeWeekly = weekly;
    let ownWeekly = null;
    if (x.weekly !== undefined) {
      typeWeekly = {};
      ownWeekly = {};
      for (const wd of WEEKDAYS) {
        const r = parseRanges(x.weekly?.[wd] ?? [], cell, `weekly.${wd}`);
        if (typeof r === "string") errs.push(r);
        else {
          ownWeekly[wd] = r;
          typeWeekly[wd] = intersectRanges(weekly[wd] ?? [], r);
        }
      }
    }
    if (x.name === undefined || typeof x.name !== "string" || !x.name.trim()) errs.push("name is required");
    if (ownerErrors.length) errs.push("the owner settings have a mistake");
    types.set(id, {
      id,
      name: String(x.name ?? id).slice(0, 80),
      description: typeof x.description === "string" ? x.description.slice(0, 1000) : "",
      minutes,
      bufferAfter,
      minNoticeHours,
      horizonDays,
      holdMinutes,
      requestHours,
      dailyCap,
      reminders: Array.isArray(reminders) ? reminders : [],
      locations: Array.isArray(locs) ? locs.filter((l) => locations[l]) : [],
      approval: x.approval === true,
      weekly: typeWeekly,
      ownWeekly,
      step,
      cell,
      on: errs.length === 0 && x.off !== true,
      errors: errs,
    });
    for (const e of errs) errors.push(`types.${id}: ${e}`);
  }
  if (!types.size) errors.push("no event types in \"types\"");
  errors.unshift(...ownerErrors);

  return {
    ok: errors.length === 0,
    errors,
    owner: {
      name: String(owner.name ?? ""),
      email: String(owner.email ?? "").toLowerCase(),
      timeZone: isZone(owner.timeZone) ? owner.timeZone : "UTC",
      weekly,
      holidays,
      holidayFeeds,
      dailyCap: ownerCap?.v ?? null,
    },
    step: STEPS.includes(step) ? step : 15,
    cell,
    defaults: d,
    limits,
    locations,
    types,
    questions,
    visitorEmail: VISITOR_EMAIL.has(visitorEmail) ? visitorEmail : "none",
    noJs: c.noJs !== false,
    allDayEvents: c.allDayEvents === "ignore" ? "ignore" : "busy",
    retentionMode: c.retentionMode === "delete" ? "delete" : "anonymise",
    ownerInvite: c.ownerInvite === "attach-only" ? "attach-only" : "request",
  };
}
