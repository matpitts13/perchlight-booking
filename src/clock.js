// The Clock: one Durable Object instance ("clock") that holds no booking
// data, only one alarm = the next due time (a hold or request expiring, a
// reminder, a retry). Durable Objects are on the Workers Free plan with the
// SQLite storage backend; each setAlarm() is billed as one row written, so
// wake() sets it only when the new time is earlier than the one already set.
// Alarms are at least once and retried by Cloudflare if the handler throws;
// housekeeping is claim-then-send, so running twice never sends twice. The
// handler catches its own errors and always sets the next alarm before
// returning. With nothing due, no alarm is set: idle costs nothing.
import { DurableObject } from "cloudflare:workers";
import { makeApp } from "./app.js";
import { runHousekeeping, nextDue } from "./lib/housekeeping.js";
import { refreshAll } from "./lib/busy.js";

const RETRY_MS = 5 * 60_000;

export function clockClass(rawConfig) {
  return class Clock extends DurableObject {
    /** The first public origin it's told about is kept (links in reminders);
     *  a different later one never replaces it. PUBLIC_URL, if set, wins anyway. */
    async rememberOrigin(origin) {
      this.origin ??= (await this.ctx.storage.get("origin")) ?? null;
      if (!this.origin && typeof origin === "string" && /^https?:\/\/[^/\s]+$/.test(origin)) {
        await this.ctx.storage.put("origin", origin);
        this.origin = origin;
      }
      return this.origin;
    }

    /** Wake at `at` (ms) unless an earlier alarm is already set. */
    async wake(at, origin) {
      await this.rememberOrigin(origin);
      const t = Math.max(Number(at), Date.now() + 1000);
      if (!Number.isFinite(t)) return null;
      const cur = await this.ctx.storage.getAlarm();
      if (cur !== null && cur <= t) return cur;
      await this.ctx.storage.setAlarm(t);
      return t;
    }

    /**
     * Fetches and parses your calendar links here, in the Durable Object's own
     * invocation, so a visitor's request never spends CPU on it. Concurrent
     * calls share one refresh.
     */
    async refreshCalendar(origin, force = false) {
      await this.rememberOrigin(origin);
      if (!this.refreshing) {
        const app = makeApp(rawConfig, this.env, { origin: this.origin ?? origin ?? "https://booking.invalid" });
        this.refreshing = refreshAll(app, app.now(), { force }).finally(() => {
          this.refreshing = null;
        });
      }
      return this.refreshing;
    }
    async getNext() {
      return this.ctx.storage.getAlarm();
    }

    async alarm() {
      await this.tick(Date.now());
    }

    /** One alarm run (also called directly by tests with a chosen time). */
    async tick(now, timeNow) {
      let next = null;
      try {
        await this.rememberOrigin(null);
        const app = makeApp(rawConfig, this.env, { origin: this.origin ?? "https://booking.invalid", now: timeNow });
        const r = await runHousekeeping(app, { now, fromAlarm: true });
        next = await nextDue(this.env);
        // Out of budget with work still due: come back shortly.
        if (next !== null && next <= now && !r.deliveries?.more && !(r.deliveries?.tried > 0)) next = now + RETRY_MS;
      } catch (err) {
        console.error(`clock alarm: ${err instanceof Error ? err.stack : String(err)}`);
        next = now + RETRY_MS;
      } finally {
        if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 2000));
      }
      return next;
    }
  };
}
