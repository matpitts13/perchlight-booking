import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import { makeWorker, makeApp, clock } from "../src/app.js";
import { resetLocalThrottle } from "../src/lib/housekeeping.js";
import { resetBlocked } from "../src/lib/ratelimit.js";
import { resetRefreshing } from "../src/lib/busy.js";
import { TEST_CONFIG, PROVIDER_CONFIG, CONFIRM_CONFIG } from "./config.js";

export const ORIGIN = "https://booking.test";
export const TOKEN = "test-admin-token-0123456789";
// Monday 2 March 2026, 08:00 in London (GMT, = UTC).
export const NOW = Date.UTC(2026, 2, 2, 8, 0);
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const workers = {
  none: makeWorker(TEST_CONFIG),
  provider: makeWorker(PROVIDER_CONFIG),
  confirm: makeWorker(CONFIRM_CONFIG),
};
export const RESEND = { MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_key" };

// A stand-in for the Clock Durable Object: records wake() calls. The real one
// is only used by the Clock tests (its alarm would fire on real time).
export const clockCalls = [];
export const fakeClock = {
  idFromName: () => "clock",
  get: () => ({
    wake: async (at) => {
      clockCalls.push(at);
      return at;
    },
    getNext: async () => (clockCalls.length ? Math.min(...clockCalls) : null),
  }),
};

export function setNow(ms) {
  clock.now = () => ms;
}

/** A fake send_email binding that records messages (or fails). */
export function fakeEmail({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    binding: {
      async send(message) {
        if (fail) throw new Error(typeof fail === "string" ? fail : "send failed");
        sent.push(message);
      },
    },
  };
}

/** Reads a raw EmailMessage the fake binding captured. */
export async function rawOf(message) {
  return new Response(message.raw).text();
}

/** A D1 stand-in where every call fails, as when writes are blocked. */
export function brokenDb() {
  const boom = async () => {
    throw new Error("D1_ERROR: writes are blocked until 00:00 UTC");
  };
  const stmt = { bind: () => stmt, first: boom, run: boom, all: boom, raw: boom };
  return { prepare: () => stmt, batch: boom, exec: boom };
}

/**
 * Fake network: Turnstile, calendar feeds (opts.feeds: url -> text | { status, body, headers } | "down"), Resend.
 */
export function mockFetch(opts = {}) {
  const calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init, body: typeof init.body === "string" ? init.body : null });
    if (url.startsWith("https://challenges.cloudflare.com/")) {
      const t = opts.turnstile ?? "pass";
      if (t === "down") throw new DOMException("The operation timed out.", "TimeoutError");
      if (t === "fail") return Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
      return Response.json({ success: true, hostname: typeof t === "object" ? t.hostname : "booking.test" });
    }
    if (opts.feeds && url in opts.feeds) {
      const f = typeof opts.feeds[url] === "function" ? opts.feeds[url](init) : opts.feeds[url];
      if (f === "down") throw new TypeError("network connection lost");
      if (typeof f === "string") return new Response(f, { headers: { "Content-Type": "text/calendar", ETag: '"v1"' } });
      return new Response(f.body ?? "", { status: f.status ?? 200, headers: f.headers ?? {} });
    }
    if (url.startsWith("https://api.resend.com/")) {
      if (opts.resendStatus) return Response.json({ name: "error", message: "refused" }, { status: opts.resendStatus });
      return Response.json({ id: `msg_${calls.length}` });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  return calls;
}

/** Sends a request through a Worker and waits for its background work. */
export async function call(path, init = {}, envOverrides = {}, which = "none") {
  resetLocalThrottle();
  const ctx = createExecutionContext();
  const res = await workers[which].fetch(new Request(`${ORIGIN}${path}`, init), { ...env, CLOCK: fakeClock, ...envOverrides }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function getJson(path, envOverrides = {}, which = "none") {
  const res = await call(path, {}, envOverrides, which);
  return { status: res.status, data: await res.json(), res };
}

export async function postJson(path, body, envOverrides = {}, which = "none", headers = {}) {
  const res = await call(path, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers }, body: JSON.stringify(body) }, envOverrides, which);
  const t = await res.text();
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    data = t;
  }
  return { status: res.status, data, res };
}

export function postForm(path, fields, envOverrides = {}, which = "none", ip = "203.0.113.9") {
  return call(path, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
    body: new URLSearchParams(fields).toString(),
  }, envOverrides, which);
}

/** Admin API call. */
export async function api(method, path, body, envOverrides = {}, token = TOKEN) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await call(`/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, envOverrides);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, res };
}

/** The app object the libraries take, for calling them directly. */
export function appFor(envOverrides = {}, config = TEST_CONFIG) {
  const app = makeApp(config, { ...env, CLOCK: fakeClock, ...envOverrides }, { origin: ORIGIN });
  return app;
}

export const visitor = { name: "Ada Lovelace", email: "ada@example.org", location: "video", timeZone: "America/New_York" };

/** Holds then confirms a time through the API. */
export async function book(startIso, { type = "30min", details = visitor, envOverrides = {}, which = "none", ip } = {}) {
  const h = await postJson("/api/hold", { type, start: startIso, turnstile: "tok" }, envOverrides, which, ip ? { "CF-Connecting-IP": ip } : {});
  if (h.status !== 200) return { hold: h };
  const c = await postJson("/api/confirm", { holdId: h.data.holdId, token: h.data.token, ...details }, envOverrides, which);
  return { hold: h, confirm: c };
}

export async function rows(sql, ...params) {
  return (await env.DB.prepare(sql).bind(...params).all()).results;
}

export async function resetAll() {
  vi.restoreAllMocks();
  resetLocalThrottle();
  resetBlocked();
  resetRefreshing();
  setNow(NOW);
  clockCalls.length = 0;
  await env.DB.batch(
    ["slot_cells", "deliveries", "bookings", "day_counts", "exceptions", "busy_cache", "blocked", "email_counts", "rate_counters", "daily_counts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.prepare("UPDATE state SET value = CASE key WHEN 'retention_errors' THEN '{}' ELSE '0' END").run();
}

/** Builds an ICS document from VEVENT bodies. */
export function ics(...events) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR", ""].join("\r\n");
}
