// Your calendar's busy times, read from its private ICS link(s) and cached
// in D1 as one compact row per link (only busy intervals in the horizon).
//
// - Slots: answered from the cache; a copy older than FEED_MINUTES is
//   refreshed after the reply (waitUntil). With no good copy yet, the
//   visitor waits for one fetch.
// - Holds: the copy must be under 30 minutes old, else the hold waits for a
//   refresh first.
// - If the feed can't be read, the last good copy is used for up to 24
//   hours; after that (or with no good copy at all) bookings pause with a
//   message, and you're emailed once per outage.
// - A feed over FEED_MAX_KB is refused, never cut short silently.
// The link is a secret: it's never stored (source = a hash) or logged.
import { parseIcs, mergeIntervals } from "./ics-parse.js";
import { sha256Hex } from "./crypto.js";
import { settings, calendarUrls } from "./settings.js";
import { spend, COST } from "./budget.js";

const MIN = 60_000;
const DAY = 86_400_000;
export const HOLD_MAX_AGE_MS = 30 * MIN;
export const STALE_LIMIT_MS = 24 * 3600_000;
const FETCH_TIMEOUT_MS = 10_000;
const refreshing = new Map(); // per isolate: source -> promise

export async function sources(app) {
  const list = [
    ...calendarUrls(app.env).map((url) => ({ url, kind: "calendar" })),
    ...app.cfg.owner.holidayFeeds.map((url) => ({ url, kind: "holiday" })),
  ];
  for (const s of list) s.key = (await sha256Hex(`ics:${s.url}`)).slice(0, 24);
  return list;
}

function horizonEnd(app, now) {
  let days = 1;
  for (const t of app.cfg.types.values()) days = Math.max(days, t.horizonDays);
  return now + (days + 2) * DAY;
}

/** Reads every cached source and decides whether bookings are paused. */
export async function readBusy(app, now) {
  const list = await sources(app);
  if (!list.length) return { list, rows: new Map(), intervals: [], paused: false, missing: [] };
  const { results } = await app.env.DB.prepare("SELECT * FROM busy_cache").all();
  const rows = new Map(results.map((r) => [r.source, r]));
  let all = [];
  const missing = [];
  let paused = false;
  for (const s of list) {
    const r = rows.get(s.key);
    if (!r || !r.ok_at) {
      missing.push(s);
      paused = true;
      continue;
    }
    if (now - r.ok_at > STALE_LIMIT_MS) paused = true;
    all = all.concat(JSON.parse(r.intervals || "[]"));
  }
  return { list, rows, intervals: mergeIntervals(all), paused, missing };
}

/**
 * Makes sure the cache is fresh enough. Returns the busy state to use.
 * mode "slots": stale copies refresh after the reply; "hold": refresh now if over 30 minutes.
 */
export async function freshBusy(app, ctx, now, mode) {
  let state = await readBusy(app, now);
  if (!state.list.length) return state;
  const maxAge = mode === "hold" ? HOLD_MAX_AGE_MS : settings(app.env).feedMinutes * MIN;
  const stale = state.list.filter((s) => {
    const r = state.rows.get(s.key);
    return !r || !r.ok_at || now - Math.max(r.ok_at, r.fetched_at) >= maxAge || (mode === "hold" && now - r.ok_at >= maxAge);
  });
  if (!stale.length) return state;
  const mustWait = mode === "hold" || stale.some((s) => !state.rows.get(s.key)?.ok_at);
  const work = Promise.all(stale.map((s) => refreshOnce(app, s, state.rows.get(s.key), now)));
  if (!mustWait) {
    ctx.waitUntil(work.catch((err) => console.error(`calendar refresh: ${err instanceof Error ? err.message : String(err)}`)));
    return state;
  }
  await work;
  state = await readBusy(app, now);
  return state;
}

function refreshOnce(app, s, row, now) {
  let p = refreshing.get(s.key);
  if (!p) {
    p = refresh(app, s, row, now).finally(() => refreshing.delete(s.key));
    refreshing.set(s.key, p);
  }
  return p;
}

/** Fetches and parses one link, if no other request just did. Never throws. */
export async function refresh(app, s, row, now = Date.now(), { force = false } = {}) {
  const { env } = app;
  if (!spend(app.budget, COST.feedFetch + 1)) return { skipped: "budget" };
  try {
    // Claim the refresh (one at a time across isolates; 60 s apart at most).
    await env.DB.prepare("INSERT OR IGNORE INTO busy_cache (source, kind) VALUES (?1, ?2)").bind(s.key, s.kind).run();
    const claim = await env.DB.prepare("UPDATE busy_cache SET fetched_at = ?2 WHERE source = ?1 AND fetched_at <= ?3")
      .bind(s.key, now, force ? now : now - MIN)
      .run();
    if (claim.meta.changes !== 1) return { skipped: "busy" };
  } catch (err) {
    console.error(`calendar refresh claim: ${err instanceof Error ? err.message : String(err)}`);
    return { skipped: "d1" };
  }
  const result = await fetchFeed(app, s, row, now);
  try {
    if (result.notModified) {
      await env.DB.prepare("UPDATE busy_cache SET ok_at = ?2, ok = 1, error = NULL WHERE source = ?1").bind(s.key, now).run();
    } else if (result.ok) {
      await env.DB.prepare(
        `UPDATE busy_cache SET ok_at = ?2, ok = 1, error = NULL, etag = ?3, last_modified = ?4, intervals = ?5, stats = ?6 WHERE source = ?1`,
      ).bind(s.key, now, result.etag, result.lastModified, JSON.stringify(result.intervals), JSON.stringify(result.stats)).run();
    } else {
      await env.DB.batch([
        env.DB.prepare("UPDATE busy_cache SET ok = 0, error = ?2 WHERE source = ?1").bind(s.key, result.error.slice(0, 300)),
        // Past 24 hours without a good copy: bookings pause; you're told once per outage.
        env.DB.prepare(
          `INSERT OR IGNORE INTO deliveries (id, booking_id, kind, sequence, due_ms, next_attempt_at, created_ms)
           SELECT 'dl_' || lower(hex(randomblob(8))), '', 'owner_paused', ok_at / 60000, ?2, ?2, ?2 FROM busy_cache
           WHERE source = ?1 AND ?2 - ok_at > ?3`,
        ).bind(s.key, now, STALE_LIMIT_MS),
      ]);
    }
  } catch (err) {
    console.error(`calendar refresh save: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

/** Fetches and parses (no D1). */
export async function fetchFeed(app, s, row, now = Date.now()) {
  const maxBytes = settings(app.env).feedMaxKb * 1024;
  const headers = { Accept: "text/calendar, */*;q=0.5", "User-Agent": "perchlight-booking" };
  if (row?.ok_at && row.etag) headers["If-None-Match"] = row.etag;
  if (row?.ok_at && row.last_modified) headers["If-Modified-Since"] = row.last_modified;
  let res;
  try {
    res = await fetch(s.url, { headers, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, error: `couldn't reach the calendar link (${err instanceof Error ? err.name : "error"})` };
  }
  if (res.status === 304) return { ok: true, notModified: true };
  if (!res.ok) return { ok: false, error: `the calendar link answered HTTP ${res.status}` };
  const len = Number(res.headers.get("Content-Length") ?? "0");
  if (len > maxBytes) {
    res.body?.cancel();
    return { ok: false, error: `the feed is ${Math.round(len / 1024)} KB, over FEED_MAX_KB (${maxBytes / 1024} KB)`, tooBig: true };
  }
  const text = await readCapped(res, maxBytes);
  if (text === null) return { ok: false, error: `the feed is over FEED_MAX_KB (${maxBytes / 1024} KB)`, tooBig: true };
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) return { ok: false, error: "the link didn't return a calendar (no BEGIN:VCALENDAR)" };
  const parsed = parseIcs(text, {
    ownerZone: app.cfg.owner.timeZone,
    now,
    until: horizonEnd(app, now),
    uidSuffix: `@${app.host}`,
    allDay: s.kind === "holiday" ? "busy" : app.cfg.allDayEvents,
  });
  return {
    ok: true,
    intervals: parsed.intervals,
    stats: parsed.stats,
    etag: res.headers.get("ETag"),
    lastModified: res.headers.get("Last-Modified"),
  };
}

async function readCapped(res, maxBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Tests only. */
export function resetRefreshing() {
  refreshing.clear();
}
