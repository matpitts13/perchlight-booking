// Your calendar's busy times, read from its private ICS link(s) and cached
// in D1 as one compact row per link (only busy intervals in the horizon).
//
// Fetching and parsing never run in a visitor's request: they run inside
// the Clock Durable Object (its own invocation and CPU budget; the Worker
// only waits on the RPC, which is I/O). Request paths only read the cache:
// - slots: a copy older than FEED_MINUTES asks the Clock to refresh after
//   the reply; with no good copy yet, the visitor waits for that refresh;
// - holds and reschedules: the copy must be under 30 minutes old, else they
//   wait for the Clock's refresh first;
// - the last good copy is used for up to 24 hours; after that (or with no
//   good copy, a feed over FEED_MAX_KB, or a CALENDAR_ICS_URLS entry that
//   can't be used) bookings pause with a message, and you're emailed once.
// A 304 keeps the copy, but a full re-read (no If-None-Match) happens at
// least every 12 hours, so busy times keep reaching the end of the horizon.
// The links are secrets: never stored (source = a hash) or logged.
import { parseIcs, mergeIntervals } from "./ics-parse.js";
import { sha256Hex } from "./crypto.js";
import { settings, calendarUrls } from "./settings.js";
import { spend, COST } from "./budget.js";

const MIN = 60_000;
const DAY = 86_400_000;
export const HOLD_MAX_AGE_MS = 30 * MIN;
export const STALE_LIMIT_MS = 24 * 3600_000;
export const REPARSE_MS = 12 * 3600_000;
const FETCH_TIMEOUT_MS = 10_000;
export const UNFINISHED = "calendar refresh did not finish (possibly the CPU limit)";

export async function sources(app) {
  const { urls, problems } = calendarUrls(app.env);
  const list = [...urls.map((url) => ({ url, kind: "calendar" })), ...app.cfg.owner.holidayFeeds.map((url) => ({ url, kind: "holiday" }))];
  for (const s of list) s.key = (await sha256Hex(`ics:${s.url}`)).slice(0, 24);
  return { list, problems };
}

function horizonEnd(app, now) {
  let days = 1;
  for (const t of app.cfg.types.values()) days = Math.max(days, t.horizonDays);
  return now + (days + 2) * DAY;
}

/** Reads every cached source and decides whether bookings are paused. */
export async function readBusy(app, now) {
  const { list, problems } = await sources(app);
  if (problems.length) return { list, problems, rows: new Map(), intervals: [], paused: true, reason: problems.join(" "), missing: list };
  if (!list.length) return { list, problems, rows: new Map(), intervals: [], paused: false, missing: [] };
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
  return { list, problems, rows, intervals: mergeIntervals(all), paused, missing };
}

/**
 * The busy state to use, asking the Clock for a refresh when it's stale.
 * mode "slots": refresh after the reply unless there's no copy; "hold": refresh first if over 30 minutes.
 */
export async function freshBusy(app, ctx, now, mode) {
  const state = await readBusy(app, now);
  if (!state.list.length || state.problems.length) return state;
  const maxAge = mode === "hold" ? HOLD_MAX_AGE_MS : settings(app.env).feedMinutes * MIN;
  const stale = state.list.some((s) => {
    const r = state.rows.get(s.key);
    return !r || !r.ok_at || now - (mode === "hold" ? r.ok_at : Math.max(r.ok_at, r.fetched_at)) >= maxAge;
  });
  if (!stale) return state;
  const work = askClock(app);
  if (mode !== "hold" && !state.missing.length) {
    ctx.waitUntil(work);
    return state;
  }
  await work;
  return readBusy(app, now);
}

/** Asks the Clock to fetch and parse now. Never throws. */
export async function askClock(app, force = false) {
  if (!app.env.CLOCK || !spend(app.budget, COST.clock)) return null;
  try {
    return await app.env.CLOCK.get(app.env.CLOCK.idFromName("clock")).refreshCalendar(app.base, force);
  } catch (err) {
    console.error(`calendar refresh via the Clock: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Runs inside the Clock: refreshes every link. Returns a report per link (no URLs). */
export async function refreshAll(app, now, { force = false } = {}) {
  const { list, problems } = await sources(app);
  if (!list.length) return { links: 0, problems, results: [] };
  const { results } = await app.env.DB.prepare("SELECT * FROM busy_cache").all();
  const rows = new Map(results.map((r) => [r.source, r]));
  const hosts = await ownHosts(app);
  const out = [];
  for (const s of list) out.push({ kind: s.kind, ...(await refresh(app, s, rows.get(s.key), now, { force, hosts })) });
  return { links: list.length, problems, results: out };
}

/** Hosts our booking UIDs were made with (so our own invites in your calendar are ignored). */
async function ownHosts(app) {
  try {
    const { results } = await app.env.DB.prepare("SELECT DISTINCT uid_host FROM bookings WHERE uid_host IS NOT NULL LIMIT 20").all();
    return [...new Set([app.host, ...results.map((r) => r.uid_host)])];
  } catch {
    return [app.host];
  }
}

/** Fetches and parses one link, if no other run just did. Never throws. */
export async function refresh(app, s, row, now = Date.now(), { force = false, hosts = [app.host] } = {}) {
  const { env } = app;
  if (!spend(app.budget, COST.feedFetch + 1)) return { skipped: "budget" };
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO busy_cache (source, kind) VALUES (?1, ?2)").bind(s.key, s.kind).run();
    // The error is written up front and cleared on success: a run killed by
    // the CPU limit (or one that throws) leaves it, so you can see it, and past
    // 24 hours without a good copy the usual "bookings paused" email goes out.
    const [, claim] = await env.DB.batch([
      // The previous run didn't finish either, and there's no usable copy: tell you (once per outage).
      env.DB.prepare(
        `INSERT OR IGNORE INTO deliveries (id, booking_id, kind, sequence, due_ms, next_attempt_at, created_ms)
         SELECT 'dl_' || lower(hex(randomblob(8))), '', 'owner_paused', ok_at / 60000, ?2, ?2, ?2 FROM busy_cache
         WHERE source = ?1 AND error = ?4 AND fetched_at <= ?2 - 60000 AND (ok_at = 0 OR ?2 - ok_at > ?3)`,
      ).bind(s.key, now, STALE_LIMIT_MS, UNFINISHED),
      env.DB.prepare("UPDATE busy_cache SET fetched_at = ?2, ok = 0, error = ?4 WHERE source = ?1 AND fetched_at <= ?3")
        .bind(s.key, now, force ? now : now - MIN, UNFINISHED),
    ]);    if (claim.meta.changes !== 1) return { skipped: "just refreshed" };
  } catch (err) {
    console.error(`calendar refresh claim: ${err instanceof Error ? err.message : String(err)}`);
    return { skipped: "d1" };
  }
  let result;
  try {
    // Conditional requests only while the last full parse is recent: its
    // intervals end at that parse's horizon.
    const conditional = !force && row?.parsed_at && now - row.parsed_at < REPARSE_MS;
    result = await fetchFeed(app, s, conditional ? row : null, now, hosts);
  } catch (err) {
    result = { ok: false, error: `the feed couldn't be read (${err instanceof Error ? err.name : "error"})` };
  }
  try {
    if (result.notModified) {
      await env.DB.prepare("UPDATE busy_cache SET ok_at = ?2, ok = 1, error = NULL WHERE source = ?1").bind(s.key, now).run();
    } else if (result.ok) {
      await env.DB.prepare(
        `UPDATE busy_cache SET ok_at = ?2, parsed_at = ?2, ok = 1, error = NULL, etag = ?3, last_modified = ?4, intervals = ?5, stats = ?6 WHERE source = ?1`,
      ).bind(s.key, now, result.etag, result.lastModified, JSON.stringify(result.intervals), JSON.stringify(result.stats)).run();
    } else {
      await env.DB.batch([
        // Too big: no copy is usable (bookings pause), as documented.
        env.DB.prepare(`UPDATE busy_cache SET ok = 0, error = ?2, ok_at = CASE WHEN ?3 THEN 0 ELSE ok_at END WHERE source = ?1`).bind(s.key, result.error.slice(0, 300), result.tooBig ? 1 : 0),
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

/** Fetches and parses (no D1). row: send its ETag / Last-Modified. */
export async function fetchFeed(app, s, row, now = Date.now(), hosts = [app.host]) {
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
  let parsed;
  try {
    parsed = parseIcs(text, {
      ownerZone: app.cfg.owner.timeZone,
      now,
      until: horizonEnd(app, now),
      ownHosts: hosts,
      allDay: s.kind === "holiday" ? "busy" : app.cfg.allDayEvents,
      ignoreTransp: s.kind === "holiday",
    });
  } catch (err) {
    console.error(`ics parse: ${err instanceof Error ? err.stack : String(err)}`);
    return { ok: false, error: "the feed couldn't be parsed" };
  }
  return { ok: true, intervals: parsed.intervals, stats: parsed.stats, etag: res.headers.get("ETag"), lastModified: res.headers.get("Last-Modified") };
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

/** Tests only (kept for compatibility). */
export function resetRefreshing() {}
