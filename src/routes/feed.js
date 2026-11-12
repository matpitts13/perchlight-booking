// GET /feed/<FEED_SECRET>.ics: your bookings as a calendar to subscribe to.
// Confirmed bookings and requests (TENTATIVE) from 30 days ago to the
// horizon; same UID and SEQUENCE as the invites; no METHOD (a subscription,
// not an invite). It includes visitors' names and emails, so the secret
// matters: changing FEED_SECRET turns the old link off.
import { safeEqual } from "../lib/crypto.js";
import { secretOk } from "../lib/settings.js";
import { text } from "../lib/http.js";
import { calendar } from "../lib/ics-write.js";
import { bookingIcs } from "../lib/notify.js";

const DAY = 86_400_000;

export async function feed(request, app, secret) {
  const { env } = app;
  if (!secretOk(env, "FEED_SECRET") || !(await safeEqual(secret, env.FEED_SECRET))) return text("Not found\n", 404);
  const now = app.now();
  let horizon = 1;
  for (const t of app.cfg.types.values()) horizon = Math.max(horizon, t.horizonDays);
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings WHERE start_ms >= ?1 AND start_ms <= ?2
       AND status IN ('confirmed', 'requested', 'cancel_requested', 'approve_requested', 'decline_requested')
     ORDER BY start_ms LIMIT 1000`,
  ).bind(now - 30 * DAY, now + (horizon + 7) * DAY).all();
  // Reuse the owner-side event of each booking, without its calendar wrapper.
  const events = results.map((b) => {
    const one = bookingIcs(app, b, { method: "FEED", forVisitor: false });
    const lines = one.split("\r\n");
    return lines.slice(lines.indexOf("BEGIN:VEVENT"), lines.lastIndexOf("END:VEVENT") + 1);
  });
  return new Response(calendar(null, events, `Bookings (${app.cfg.owner.name})`), {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex" },
  });
}
