// The Worker, built around a booking config (booking.json in production;
// tests pass their own). No cron trigger: see docs/SDD.md, "Reminders and housekeeping without cron".
import { checkConfig } from "./lib/config.js";
import { settings } from "./lib/settings.js";
import { newBudget } from "./lib/budget.js";
import { json, text } from "./lib/http.js";
import { maybeHousekeep } from "./lib/housekeeping.js";
import { publicApi, noJsRoutes } from "./routes/public.js";
import { manageRoutes } from "./routes/manage.js";
import { feed } from "./routes/feed.js";
import { handleAdmin } from "./routes/admin.js";

// booking.json is checked once per isolate.
const checked = new WeakMap();
export function configFor(raw) {
  let c = checked.get(raw);
  if (!c) {
    c = checkConfig(raw);
    checked.set(raw, c);
  }
  return c;
}

/** The time source (tests replace clock.now). */
export const clock = { now: () => Date.now() };

/** What the routes and libraries take: env, the checked config, the public base URL, a budget, now(). */
export function makeApp(raw, env, { origin, now } = {}) {
  const base = settings(env).publicUrl || origin;
  let host = "localhost";
  try {
    host = new URL(base).host;
  } catch {
    // keep localhost
  }
  return { env, cfg: configFor(raw), base, host, budget: newBudget(), now: now ?? (() => clock.now()) };
}

const PUBLIC_API = new Set(["types", "slots", "hold", "confirm"]);

export function makeWorker(raw) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;
      const app = makeApp(raw, env, { origin: url.origin });
      try {
        if (path.startsWith("/api/")) {
          const rest = path.slice(5);
          const res = PUBLIC_API.has(rest) ? await publicApi(request, app, ctx, rest) : await handleAdmin(request, app, ctx, rest);
          maybeHousekeep(app, ctx);
          return res;
        }
        if (/^\/[bvr]\//.test(path)) {
          const res = await manageRoutes(request, app, ctx, path);
          maybeHousekeep(app, ctx);
          return res;
        }
        if (path === "/nojs" || path.startsWith("/nojs/")) {
          const res = await noJsRoutes(request, app, ctx, path);
          maybeHousekeep(app, ctx);
          return res;
        }
        const f = /^\/feed\/([^/]+)\.ics$/.exec(path);
        if (f && request.method === "GET") return await feed(request, app, f[1]);
        if (path === "/tick") {
          // For an uptime monitor: lets a quiet deployment catch up (throttled).
          maybeHousekeep(app, ctx);
          return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
        }
        return env.ASSETS ? env.ASSETS.fetch(request) : text("Not found\n", 404);
      } catch (err) {
        console.error(`${request.method} ${path}: ${err instanceof Error ? err.stack : String(err)}`);
        const contact = settings(env).fallbackContact;
        return path.startsWith("/api/")
          ? json({ ok: false, error: `Booking isn't possible right now.${contact ? ` Please contact ${contact}.` : ""}` }, 500)
          : text(`Something went wrong. Please try again.${contact ? ` Or contact ${contact}.` : ""}\n`, 500);
      }
    },
  };
}
