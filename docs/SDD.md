# SDD: perchlight-booking

**Version:** 0.1
**Date:** 2026-11-11
**Status:** Approved (2026-11-11, every recommended answer below)

## Summary

A free, self-hosted booking page ("pick a time with me") running on your own Cloudflare account (Workers + D1 + one small Durable Object). You set your event types (for example 15, 30 and 60 minutes), your weekly hours, days off, buffers and limits in your own time zone. The Worker reads your existing calendar through its private iCal (ICS) link, so times you're already busy never show as free, and visitors see the remaining times in their own time zone. A booking is held while the visitor types their details, then confirmed in one database transaction that cannot double-book. You get an email with a calendar invite (`.ics`); the visitor gets a confirmation page with an "Add to calendar" file and a private link to cancel or reschedule, and an email too if you connect an email service. Bookings also appear in a private ICS feed you can subscribe to. Reminders are timed by a Durable Object alarm, not a cron trigger. It replaces Calendly / Cal.com subscriptions for one person. Part of the Perchlight family: the Perchlight desktop app gets screens for upcoming bookings, requests waiting for approval, days off and failed notifications.

## Why

- Calendly's free plan allows one event type and one calendar connection; Standard is $10 a seat a month and Teams $16, billed yearly ([calendly.com/pricing](https://calendly.com/pricing), checked 2026-11-11; the monthly-billed prices aren't shown on the page). Cal.com's free plan is generous for one user (unlimited event types) but your bookings and visitors' details live on their servers; Teams is $12 a user a month ([cal.com/pricing](https://cal.com/pricing), checked 2026-11-11).
- Here the bookings, the visitors' names and emails, and your calendar's busy times stay in your Cloudflare account, for as long as you choose, and nothing is a subscription.
- Cloudflare's free plan is far more than one person's booking page needs (numbers under "Footprint").

## Requirements

### Must have

- **Event types**, each with: name, slug (`/30min`), duration, description, location options, buffer after, minimum notice, booking horizon, daily cap, slot step, questions (name and email always; phone and notes optional), and "needs my approval" on or off.
- **Availability rules in your time zone:** weekly hours (several ranges a day, for example 09:00–12:00 and 13:00–17:00), date exceptions (a day off, or different hours on one date), holidays (a list of dates, or a public-holiday ICS link), a minimum notice (default 4 hours), a horizon (default 60 days), a daily cap per event type and an overall daily cap (both in your time zone's days).
- **Time zones done right:** bookings stored in UTC; rules in your IANA zone (for example `Europe/London`); slots shown in the visitor's zone (detected by the browser, changeable from a list); daylight-saving changes handled (see "Time zones").
- **Busy times from your own calendar** through its private ICS link (Google, Outlook, iCloud, or anything that publishes ICS), parsed in the Worker with no dependencies, including repeating events (RRULE, EXDATE, RDATE, RECURRENCE-ID changes), all-day events, and time zones. Unknown repeat rules block time rather than free it.
- **No double booking, ever.** Two visitors can't both get the same time, and a booking can't overlap another booking (including its buffer). Enforced by D1 constraints inside one transaction, not by checking first and hoping (see "Holding and confirming").
- **Hold, then confirm.** Picking a time holds it for 10 minutes while the visitor types; confirming turns the hold into a booking. A hold that expires frees the time on its own.
- **Optional "I approve each booking" mode** per event type: the time is held as a request (default up to 48 hours) until you approve or decline from a link in your email, the admin API or the desktop app.
- **Nothing lost or double-booked silently.** Every attempt ends as one of: shown back to the visitor as a problem they can act on ("that time was just taken, here are the nearest free times"), a hold that expires visibly, a request, a confirmed booking, or a cancelled / declined booking with who did it and when.
- **Email to you** for each new booking, request, cancellation and reschedule, with an `.ics` invite, through the free Workers `send_email` binding to your verified addresses.
- **The visitor always gets the booking, even with no email service:** a confirmation page with the details, a downloadable `.ics`, "Add to Google Calendar" / "Outlook" links, and a private manage link (cancel / reschedule). Email to the visitor needs an email service you connect (see "Emails to the visitor: the honest part").
- **Correct calendar invites:** one `UID` per booking for its whole life, `SEQUENCE` increased on every change, `METHOD:REQUEST` for new and changed bookings, `METHOD:CANCEL` for cancellations, so calendar apps update the same event instead of adding a second one.
- **Cancel and reschedule links**, signed and expiring, that need no account. Reschedule is atomic: the new time is taken and the old one released in one transaction, or nothing changes.
- **Reminders without a cron trigger:** a Durable Object alarm wakes the Worker when the next reminder is due (default 24 hours and 1 hour before, to you, and to the visitor if an email service is connected). The lazy housekeeping pattern from perchlight-forms catches anything an alarm missed.
- **A private ICS feed of your bookings** (`/feed/<secret>.ics`) to subscribe to from any calendar app; the secret can be changed.
- **Meeting location:** in person (an address), phone (you call them, or they call you), or a video link you paste (per event type, or per booking when you approve). No Zoom or Meet API.
- **Spam and abuse protection without storing IPs:** Turnstile on holding a time, a per-network hourly limit keyed by a daily-rotating salted hash (perchlight-forms' method), a cap on holds at once, a cap on upcoming bookings per email address, daily caps, and a block list.
- **Privacy:** no IP addresses, user agents or cookies stored; retention (default: personal details removed 90 days after the meeting); delete everything for one email address in one call; export for a subject access request.
- **Plain, accessible booking page:** static HTML and about 10 KB of JavaScript, no framework; works on phones; keyboard and screen-reader usable; works without JavaScript too (times shown in your time zone, plain form posts), with Turnstile off for that path's limits explained in the README.
- **Admin API** behind `ADMIN_TOKEN` (bearer, constant-time compare, 16+ characters), like perchlight-updates'.
- **Desktop app screens** in `perchlight/perchlight.json`.
- **Its own footprint is stated in numbers** (see "Footprint").
- **Deploy to Cloudflare button**, `npm test` (vitest with the Workers pool), README, MIT licence, no runtime dependencies, v0.1.0 release, graphify on creation, GitHub Actions CI on the free tier.

### Should have

- `POST /api/test-notify` sends a sample booking email with `.ics` to you (and to a visitor address you give, if an email service is set), so you can see the invite land in your calendar app before a real visitor books.
- `GET /api/calendar-check` fetches your ICS link now and reports: events read, repeating series, rules it couldn't fully expand (and how it treated them), time zones it didn't recognise, the busy times for the next 7 days, and the feed's size.
- "Confirm your email" mode (needs an email service): a booking stays a hold until the visitor clicks the link sent to them, so nobody can book under someone else's address.
- A Google Calendar "free/busy" connection (OAuth) as an alternative to the ICS link, in v0.2 (see "Google free/busy API, later").
- Embeddable: an `<iframe>`-friendly page and a copy-paste link button for your website.

### Out of scope (v0.1)

- **Payments.** Taking money means a payment provider account (Stripe or similar), webhooks, refunds when someone cancels, receipts, tax rules and per-transaction fees: it's no longer free, and it's a different product's worth of edge cases. See "Payments, later".
- Teams, round-robin, collective availability, several owners per deployment. One deployment = one person's calendar.
- Writing events into your calendar through an API. The invite email and the bookings feed do that job without OAuth.
- Zoom / Google Meet / Teams link creation through their APIs.
- SMS reminders (paid everywhere).
- Recurring bookings ("every Tuesday for 6 weeks") and group events with several seats.
- Editing event types from the desktop app (they live in `booking.json`; date exceptions are editable, see "Config").

## Technical design

### Pieces

```
Visitor's browser                         Your Cloudflare account
─────────────────                         ────────────────────────────────────────────────────────
/30min (static HTML + JS) ─GET slots──▶  Worker ──fetch (cached)──▶ your calendar's private ICS link
                          ─POST hold──▶    │  ──siteverify──▶ challenges.cloudflare.com
                          ─POST confirm─▶  │
manage link /b/<id>?t=... ─────────────▶   ├──▶ D1: bookings, slot cells, day counts, deliveries,
                                           │        busy cache, exceptions, rate counters, state
                                           ├──▶ Durable Object "Clock" (SQLite-backed, Free plan):
                                           │        one alarm = the next due reminder / expiry
                                           │  after the reply (waitUntil), or when Clock wakes it:
                                           ├──▶ send_email binding ──▶ your verified addresses
                                           └──▶ Resend / SES / Mailgun / Postmark (optional) ──▶ visitor

Your calendar app ──subscribes──▶ /feed/<secret>.ics       Perchlight desktop app ──▶ D1 screens
You / scripts ──▶ /api/* (ADMIN_TOKEN)
```

- **Worker** (`src/`): public booking API, manage and approve pages, the bookings feed, the admin API, `GET /tick`. **No cron trigger** (see "Reminders and housekeeping without cron").
- **Static pages** (`public/`): the event list, booking page, confirmation, manage and problem pages, served by Workers static assets. Cloudflare says requests to static assets are free and unlimited ([billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)), so page views don't use Worker requests; only the JSON calls do.
- **D1 binding** `DB`: all data. The desktop app reads D1, as for the rest of the family.
- **Durable Object** `CLOCK` (one instance, named `clock`): holds no booking data, only an alarm. Durable Objects are on the Workers Free plan with the SQLite storage backend only; alarm invocations count as requests and each `setAlarm()` is billed as one row written ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). Declared with a `new_sqlite_classes` migration.

### What's shared with the rest of the family

Copied (not imported, to keep zero runtime dependencies), with a comment naming the source file:

| From | What | Changes for booking |
|---|---|---|
| perchlight-forms `src/lib/budget.js` | per-request subrequest budget (45 of 50, binding calls assumed to count) | costs for ICS fetch, DO call, `.ics` email |
| perchlight-forms `src/lib/housekeeping.js` | lazy housekeeping throttled by a `state` row, bounded steps, saved progress | also run by the Clock alarm |
| perchlight-forms deliveries | one delivery row per (booking, kind, sequence), claim-then-send, retries 1 / 5 / 30 min, 2 h, 12 h, `config` / `unknown` results | reminders whose meeting has started are dropped as `skipped`, not sent late |
| perchlight-forms / perchlight-list | senders (`send_email`, Resend, SES, Mailgun, Postmark, Cloudflare Email Service), Turnstile `siteverify` with 5 s timeout and `hostname` check, daily-keyed network hash rate limit | multipart MIME with a `text/calendar` part |
| perchlight-forms file links | `HMAC(LINK_SECRET, ...)` signed, expiring links, constant-time compare | used for manage, approve and `.ics` links |
| perchlight-updates `admin.js` | `Authorization: Bearer <ADMIN_TOKEN>` | — |

### Config

`booking.json` in your copy of the repo, imported at build time (a push redeploys), checked by `npm test` and again once per isolate. An event type with a mistake is switched off (its page says "this booking type isn't set up correctly") and `GET /api/config` names the mistake; the others keep working.

```jsonc
{
  "owner": {
    "name": "Sam Example",
    "email": "sam@example.com",           // send_email: verified in Email Routing
    "timeZone": "Europe/London",          // IANA name; all rules below are in this zone
    "weekly": {
      "mon": [["09:00", "12:00"], ["13:00", "17:00"]],
      "tue": [["09:00", "17:00"]],
      "wed": [], "thu": [["09:00", "17:00"]], "fri": [["09:00", "13:00"]],
      "sat": [], "sun": []
    },
    "holidays": ["2026-12-25", "2026-12-26"],
    "holidayFeeds": [],                   // public-holiday ICS links; their days are off
    "dailyCap": 6                         // all event types together, per day in owner's zone
  },
  "defaults": {
    "minNoticeHours": 4, "horizonDays": 60, "bufferAfterMinutes": 15,
    "stepMinutes": 15, "holdMinutes": 10, "requestHours": 48,
    "reminders": [1440, 60]               // minutes before start
  },
  "types": {
    "15min": { "name": "Quick chat", "minutes": 15, "locations": ["video"] },
    "30min": { "name": "Call", "minutes": 30, "locations": ["video", "phone"], "dailyCap": 4 },
    "60min": {
      "name": "Workshop", "minutes": 60, "locations": ["in-person"],
      "approval": true, "minNoticeHours": 48,
      "weekly": { "tue": [["10:00", "16:00"]] }        // narrower than the owner's hours
    }
  },
  "locations": {
    "video":     { "kind": "video", "link": "https://meet.example.com/sam" },   // a link you paste
    "phone":     { "kind": "phone", "who": "visitor-gives-number" },          // or "owner-number"
    "in-person": { "kind": "in-person", "address": "1 Example Street, London" }
  },
  "questions": { "phone": "optional", "notes": "optional" },
  "visitorEmail": "none"                   // "none" | "provider" | "provider-confirm" (see below)
}
```

- An event type's own `weekly` can only narrow the owner's hours (the intersection is used), so one change to your week applies everywhere.
- `stepMinutes` (5, 10, 15, 20, 30 or 60) is the grid slots start on. Durations and buffers must be multiples of it; the check says so if not.
- **Date exceptions live in D1** (`exceptions` table), not the config, so you can add "off on 3 March" or "only 10:00–12:00 on 5 March" from the desktop app or `POST /api/exceptions` without a redeploy.
- Global settings, `wrangler.jsonc` `vars`: `PUBLIC_URL`, `MAIL_FROM`, `MAIL_PROVIDER` (`cloudflare-routing` default, or `resend` | `ses` | `mailgun` | `postmark` | `cloudflare`), `FEED_MINUTES` (10), `RETENTION_DAYS` (90 after the meeting), `FALLBACK_CONTACT`. Secrets: `ADMIN_TOKEN`, `LINK_SECRET`, `IP_SALT`, `CALENDAR_ICS_URLS` (one or more of your private ICS links, comma-separated; they're secrets because anyone holding one can read your calendar), `FEED_SECRET` (the bookings feed's path), `TURNSTILE_SECRET_KEY`, and the email-service secrets perchlight-list documents.

### Routes

| Route | Who | What |
|---|---|---|
| `GET /`, `GET /:type` | public (static) | Event list; booking page. |
| `GET /api/slots?type=&from=&to=` | public | Free slots as UTC ISO times, at most 14 days per call. `Cache-Control: no-store`. |
| `POST /api/hold` | public | `{ type, start, turnstile }` → `{ holdId, token, expiresAt }` or `409 { taken: true, nearest: [...] }`. |
| `POST /api/confirm` | public | `{ holdId, token, name, email, phone?, notes?, location, timeZone }` → booking (or request) with manage link. |
| `GET /b/:id?t=` | link holder | Manage page: details, `.ics`, cancel, reschedule. A GET never changes anything (email scanners open links). |
| `POST /b/:id/cancel`, `POST /b/:id/reschedule` | link holder | Cancel with optional reason; move to a new start (same hold rules). |
| `GET /b/:id/invite.ics?t=` | link holder | The current `.ics` for that booking. |
| `GET /r/:id?t=` · `POST /r/:id/approve` · `POST /r/:id/decline` | owner link | Approve page (can paste a video link), approve or decline. |
| `GET /feed/:secret.ics` | owner's calendar app | All upcoming and last-30-days bookings and requests. |
| `GET /tick` | anyone | Runs housekeeping if due (as in perchlight-forms). |
| `/api/*` (others) | `ADMIN_TOKEN` | See "Admin API". |

The no-JavaScript path: the booking page is a plain `<form>` listing times in your zone (labelled "times in London time"); posting it does hold and confirm in one request (form body, 303 to the confirmation or problem page). Without JavaScript there's no Turnstile, so that path is held to a tighter per-network limit (default 2 an hour) and the README says so. An owner can switch it off (`"noJs": false`).

### Time zones

Rules: availability is wall-clock time in your zone; bookings are instants in UTC; visitors see instants in their zone.

- **Slots are generated per local day in your zone.** For each date in the horizon: take the weekly ranges for that weekday, apply that date's exception, remove holidays, then convert each range's local start and end to UTC. Converting is done with `Intl.DateTimeFormat` (built into Workers, with full IANA zone data) by finding the zone's offset at that instant; offsets are cached per zone per day, so a 60-day horizon costs about 120 conversions, not one per slot.
- **Spring forward (a local hour doesn't exist):** a range is converted as two instants, so 09:00–17:00 is still 8 real hours; a range edge in the missing hour (for example 01:30 in London on the last Sunday of March) moves forward to the first valid time, and slot starts inside the gap don't exist.
- **Fall back (a local hour happens twice):** a range start uses the earlier offset and a range end the later one, so the full range is offered; a slot start that's ambiguous uses the earlier instant. (Same choice as Temporal's `"compatible"` disambiguation.) The page shows times with their UTC offset on those days.
- **Visitor's zone:** the page reads `Intl.DateTimeFormat().resolvedOptions().timeZone`, shows all times in it with the zone name, and offers a searchable zone list. The chosen zone is stored on the booking only to write emails and the manage page in the visitor's time. The API never accepts local times, only UTC instants, so the visitor's zone can't change what gets booked.
- **Daily caps and "days"** are your days, in your zone, because they protect your time.
- **Zones in calendar feeds:** Google and iCloud use IANA names in `TZID`. Outlook often uses Windows names (`"GMT Standard Time"`); an embedded Windows-to-IANA table (from CLDR's `windowsZones.xml`, about 140 entries, under 5 KB) maps them. An unknown `TZID` falls back to the feed's own `VTIMEZONE` block (its `STANDARD`/`DAYLIGHT` offsets and rules); a `TZID` with neither is treated as your zone and reported by the calendar check. Floating times (no zone) are your zone. Dates in UTC (`...Z`) are used as is.
- **Zone rule changes:** stored bookings are UTC instants, so if a government changes its daylight-saving rules, existing bookings keep their real time; emails show the new local time. The README notes that zone data comes with the Workers runtime, not the project.

### Busy times from your calendar (ICS)

**Getting the link** (README walks through each):

- Google: Settings → your calendar → Integrate calendar → **Secret address in iCal format**. Anyone with it can read the calendar; **Reset** makes a new one. A work or school admin may have hidden it ([Google help](https://support.google.com/calendar/answer/37648?hl=en)).
- Outlook on the web: Settings → Calendar → Shared calendars → **Publish a calendar**, choose the level of detail, publish, and copy the ICS link. Microsoft says published calendars are viewable by anyone with the link ([Microsoft support](https://support.microsoft.com/en-us/office/introduction-to-publishing-internet-calendars-a25e68d6-695a-41c6-a701-103d44ba151d)). Choosing the busy-only level is recommended, since only busy times are needed (the exact option names weren't confirmed on that page).
- iCloud: share a calendar as a **Public Calendar** and use its `webcal://` link (as `https://`). This shares full details with anyone who has the link; the README says so and suggests a separate "busy" calendar if that matters. (Not checked against Apple's docs in this draft.)
- Several links can be given (work and personal); busy times are merged.

**Fetching and caching:**

- The feed is fetched when someone asks for slots and the cache is older than `FEED_MINUTES` (default 10). The visitor is answered from the cache at once; the refresh runs after the reply (`waitUntil`). Only the busy intervals inside the horizon are kept, as one compact row per link in `busy_cache` (start/end pairs as integers in minutes, a few KB), with `fetched_at`, `etag`/`last-modified` (sent back as `If-None-Match` / `If-Modified-Since`, so an unchanged feed costs no parsing), and the last error.
- **Before a hold is granted**, the cache must be no older than 30 minutes; if it is older, the hold request refreshes it first (the visitor waits for one fetch). If the feed can't be fetched, the last good copy is used for up to 24 hours, after which the page stops offering times and says "bookings are paused while the calendar can't be read" (and you're emailed once). Offering times from a day-old calendar would risk clashes.
- **What this can't promise:** an event you add to your own calendar is only seen once your calendar provider updates the ICS link and the cache refreshes. How quickly Google, Outlook and iCloud update their ICS links isn't documented (not confirmed). So a clash between a booking and something you added to your calendar a few minutes earlier is possible; a clash between two bookings made here is not. The README says this plainly.
- **Our own bookings in the feed:** if you accept the invite, the booking also appears in your calendar's ICS. Events whose `UID` ends with `@<your worker host>` are ignored when reading the feed, so a booking never blocks its own reschedule, and a cancelled booking still in your calendar for a while doesn't matter (slot cells, not the feed, decide).

**Parsing, no dependencies:** a single pass over the text, unfolding lines (RFC 5545 continuation lines), reading only `VEVENT` blocks and the properties needed: `DTSTART`, `DTEND`/`DURATION`, `RRULE`, `RDATE`, `EXDATE`, `RECURRENCE-ID`, `STATUS`, `TRANSP`, `UID`, and `VTIMEZONE` blocks. Summaries, descriptions, attendees and locations are skipped without being stored: only busy intervals leave the parser.

- `STATUS:CANCELLED` and `TRANSP:TRANSPARENT` ("free") events are skipped. Google marks all-day events as free by default; an all-day event that is busy (`OPAQUE`) blocks that whole date in your zone. `"allDayEvents": "ignore"` is available for people whose calendars are full of busy all-day reminders.
- Events entirely before now and without `RRULE` are skipped as soon as `DTEND` is read, so a long history costs little.
- **RRULE support** (what fits in a small, testable expander): `FREQ` = `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`; `INTERVAL`, `COUNT`, `UNTIL`, `WKST`; `BYDAY` (with ordinals such as `2TU` and `-1FR` for monthly and yearly), `BYMONTHDAY` (including negative), `BYMONTH`, `BYSETPOS`. Expansion runs only inside the window from now to the horizon; series with `COUNT` are counted from their start (with a cap of 5,000 iterations per series), and expansion happens in the event's own zone, so a 09:00 weekly meeting stays at 09:00 across DST. `EXDATE` removes instances; `RECURRENCE-ID` events replace theirs; `RDATE` adds.
- **Not supported:** `FREQ=HOURLY`/`MINUTELY`/`SECONDLY`, `BYYEARDAY`, `BYWEEKNO`, `BYHOUR`/`BYMINUTE`/`BYSECOND`. Such a series is treated as **busy every day at that time of day** for the whole horizon (it blocks too much, never too little) and listed by `GET /api/calendar-check`.

**CPU, the open risk.** Workers Free allows 10 ms of CPU per request; waiting on the fetch doesn't count, the parsing does ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). A personal Google calendar's ICS link contains every event ever, so it can be megabytes; how much fits in 10 ms hasn't been measured. Also, a Worker can't measure its own CPU time (timers don't advance during computation), so the parser can't stop itself at "9 ms". Plan:

1. **Plan A (built first):** single-pass parse after the reply, with a size cap (`FEED_MAX_KB`, starting at 1,024 KB, set from measurements during the build). Measured in the build on real exported feeds of several sizes, with `wrangler dev` and on a real Free account (CPU time per invocation is shown in the dashboard).
2. **Plan B (only if measurements say Plan A's cap is too small for normal calendars):** the Clock Durable Object fetches the feed, stores it in its own SQLite as chunks cut at `END:VEVENT` boundaries (about 100 KB each), and parses one chunk per alarm invocation, building the busy row when the last chunk is done. A 2 MB feed refreshed every 10 minutes while people are looking would cost about 20 rows written per refresh. The DO's CPU limit per invocation on Free isn't stated on its limits page (not confirmed), so this plan is also measured.
3. A feed over the cap is not silently truncated: bookings pause with a clear message in the calendar check, and the README suggests the Outlook busy-only link or a smaller calendar.

**Google free/busy API, later.** Google's `freebusy.query` returns busy intervals already expanded (no RRULE work, no feed size problem, near-real-time) and accepts the narrow `calendar.freebusy` scope ([API reference](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)). It needs a Google Cloud project, an OAuth consent screen, a stored refresh token (a secret, refreshed by the Worker) and, for a published app with that scope, possibly Google's verification (not checked). Quota and price weren't stated on the reference page (not confirmed; Calendar API usage is generally free within quota). It's Google-only and setup-heavy, so ICS stays the default and free/busy is a v0.2 option alongside it.

### Holding and confirming (no double booking)

**Slot cells.** Time is divided into cells of `stepMinutes` (UTC instants on the grid). A hold or booking claims every cell from its start to its end **plus its buffer after**. `slot_cells.cell` is the **primary key**, so two claims on the same cell can't both exist. On a 15-minute grid, a 30-minute call with a 15-minute buffer claims 3 cells. (Only a buffer *after* is claimed; a buffer *before* would make two back-to-back claims collide even when the gap is enough. Busy times from your calendar are padded by the buffer on both sides when slots are offered.)

**Hold** (`POST /api/hold`), cheapest checks first, nothing written until step 5:

1. Event type exists and is on; `start` is on the grid, inside the horizon, past minimum notice, and inside availability. Else 422 with the reason.
2. Rate limit (per network, daily-keyed hash; default 10 holds an hour) and a deployment-wide cap of active holds (default 20). Else 429, shown.
3. Turnstile (`siteverify`, single-use tokens valid 300 s). Failed: "please complete the check again". Cloudflare unreachable: refused with "try again in a minute" (unlike forms, a hold has no spam folder to fall back to).
4. Busy cache fresh enough (see above), and the time isn't busy in it.
5. **One D1 batch (a single transaction):**
   - delete cells belonging to expired holds and expired requests among the cells about to be claimed (so an abandoned hold never blocks anyone);
   - insert the `bookings` row (`status = 'held'`, `hold_expires_at = now + holdMinutes`);
   - insert its cells;
   - increment `day_counts` for the type and for all types on that local day, rows that carry their cap and a `CHECK (n <= cap)`.

   A primary-key clash on a cell or a failed `CHECK` rolls the whole batch back. The answer is `409` with "that time was just taken" (or "that day is full") and the nearest free times. Any other D1 error is a 503 that says booking isn't possible right now and gives `FALLBACK_CONTACT`; nothing was written.

**Confirm** (`POST /api/confirm`): checks the hold token (random, stored hashed), that the hold hasn't expired, validates name / email / phone / notes / location choice, then one `UPDATE ... SET status = 'confirmed' (or 'requested') WHERE id = ? AND status = 'held' AND hold_expires_at > now`, with the delivery rows inserted in the same batch. If the update changed no row, the hold had expired: the visitor sees "your hold ran out" and, if the time is still free, a button to hold it again. Then emails go out after the reply.

**Owner approval:** a `requested` booking keeps its cells until approved, declined, or `requestHours` pass (then `expired`, cells released, visitor told on the page and by email if possible, you told by email). The approve link opens a page with a button (a POST), never a one-click GET, because mail scanners follow links.

**Reschedule:** one batch that claims the new cells, moves the counts, releases the old cells and updates the booking's start, end and `sequence`. Either all happens or nothing does; a taken time is a 409 like a hold. The booking keeps its id and `UID`.

**Cancel:** status `cancelled`, cells and counts released in one batch, `sequence + 1`, who cancelled (`visitor` / `owner`) and an optional reason kept.

**Why not just the Durable Object?** A single DO would serialise all bookings and also prevent double booking. D1 constraints do it without making every booking depend on one object, and keep the data where the desktop app reads it.

### Emails and calendar invites

**Email to you:** through `send_email` to your verified address, free on all plans; recipients must be verified destinations ([email service pricing](https://developers.cloudflare.com/email-service/platform/pricing/), [send_email](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)). The message is built as raw MIME by the Worker (no library): `multipart/mixed` containing `multipart/alternative` (plain text + escaped HTML, with a `text/calendar; method=REQUEST` part, the form Outlook and Gmail recognise as an invite) and the same `.ics` as an attachment. Visitor-typed values are escaped and never put in headers raw; `Reply-To` is the visitor's address only if it's one valid address.

**The `.ics`** (RFC 5545 / iTIP RFC 5546):

- `UID:<booking id>@<worker host>`, the same for the booking's whole life.
- `SEQUENCE`: 0 when booked, +1 on each reschedule, approval with a new link, or cancel. `DTSTAMP` is the time of that version.
- `METHOD:REQUEST` for new and changed bookings, `METHOD:CANCEL` with `STATUS:CANCELLED` for cancellations, with `ORGANIZER` = you and `ATTENDEE` = the visitor.
- Times in UTC (`...Z`), so no `VTIMEZONE` is needed and no app can misread a zone.
- `LOCATION` and a description with the location detail and the manage link; a `VALARM` matching the first reminder (some apps ignore alarms in invites; not relied on).
- The visitor's downloadable `.ics` (no email service) uses `METHOD:PUBLISH` because no reply is expected; a later cancellation can't reach their calendar, which the confirmation page says ("if you cancel, remove it from your calendar").

**Calendar-app behaviour is the least certain part.** How Gmail, Outlook and Apple Calendar treat an invite where the recipient is the organizer (your own copy) varies; the build tests each with free accounts and the README records what happens. If your copy behaves badly, the bookings feed is the reliable path for your own calendar, and `"ownerInvite": "attach-only"` sends the `.ics` without the `method=REQUEST` part.

### Emails to the visitor: the honest part

`send_email` only reaches addresses verified in your own Email Routing. A visitor's address is not one of them, and Cloudflare's Email Service needs Workers Paid to email arbitrary addresses ([email service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)). So with nothing extra, **the free setup cannot email the visitor.** The options, set by `visitorEmail`:

| Mode | What the visitor gets | Cost / setup |
|---|---|---|
| `none` (default) | Confirmation page with details, `.ics` download, Add-to-Google/Outlook links and the manage link ("bookmark this page"). No reminder or cancellation email; cancellation by you shows on their manage page. You get everything by email. | Free, nothing to set up. |
| `provider` | All of the above plus confirmation, change, cancellation and reminder emails with `.ics` (`METHOD:REQUEST` / `CANCEL`). | A free tier of an email service on a domain you verify with it, the senders perchlight-list uses. For example Resend's free plan: 100 emails a day, 3,000 a month, 3 domains ([resend.com/pricing](https://resend.com/pricing), checked 2026-11-11). SES, Mailgun and Postmark free tiers weren't re-checked for this draft. |
| `provider-confirm` | As `provider`, and the booking stays a hold until the visitor clicks the link in the first email (hold extended to 30 minutes). | Same. |

With an email service, visitor email is abuse-prone in the same way as perchlight-forms' auto-reply: anyone can type a stranger's address. So: Turnstile is required for holds; the email text is fixed (your text, the time, location and links), and the visitor's name is the only typed value shown (cut to 60 characters, no links rendered); at most 2 confirmation emails per address per day (hashed); a daily cap per deployment (default 50); `provider-confirm` is recommended where strangers book. At 4 emails per booking (confirmation, 2 reminders, maybe a change), Resend's free 100 a day covers about 25 bookings a day.

### Reminders and housekeeping without cron

The account's 5 cron triggers are nearly used up (perchlight-guard, -list and -updates use four), so this uses none.

- **Clock Durable Object.** One instance with one alarm. After any change that creates or moves a due time (a hold's expiry, a request's expiry, a reminder, a retry), the Worker calls `clock.wake(at)`; the DO calls `setAlarm(at)` only if `at` is earlier than the alarm already set (`getAlarm()`), so it's usually one DO request and one row written per booking. Each DO can hold one alarm, and a new `setAlarm` replaces it; alarms are guaranteed at least once and retried with exponential backoff from 2 seconds, up to 6 times, when the handler throws ([DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)).
- **When the alarm fires**, the DO runs the shared housekeeping with its `env` (D1, senders): sends due reminders (claim-then-send, so an at-least-once alarm never sends twice), expires holds and requests, retries failed deliveries, runs retention in bounded steps, then sets the next alarm from `SELECT MIN(due)` across those tables. It catches its own errors and always sets the next alarm before returning (as Cloudflare advises), so a long outage can't stop the clock.
- **Lazy fallback,** exactly as perchlight-forms: the same housekeeping also runs after public and admin requests and `GET /tick`, throttled by a timestamp row. If the DO were unavailable, reminders would be late until someone visits, never lost.
- **Reminders that would be late** are not sent after the meeting started: they're marked `skipped` with the reason. A reminder due while D1 writes are blocked is sent when writes return, if still before the start.
- **Idle cost:** with no upcoming bookings no alarm is set, so it uses no requests at all.

### Bookings feed

`GET /feed/<FEED_SECRET>.ics` lists confirmed bookings and requests from 30 days ago to the horizon (requests marked `TENTATIVE`), `METHOD` omitted (a subscription, not an invite), same `UID` and `SEQUENCE` as the invites, with visitor name and email in the description (so the secret matters: the README says so, and changing `FEED_SECRET` disables the old link). `Cache-Control: private, max-age=300`. How often Google, Outlook and Apple re-poll subscribed feeds isn't documented (not confirmed; commonly reported as hours for Google), so the feed is a convenience, not a real-time view: emails are.

### Meeting location

- **Video:** a link you paste: a personal room link per location (Zoom, Meet, Teams, Jitsi, Whereby, anything), or per booking on the approve page / `PATCH /api/bookings/:id`. Shown only after booking (in emails, the manage page and the `.ics`), not on the public page. No API calls, no accounts.
- **Phone:** you call them (phone number field required) or they call you (your number shown after booking).
- **In person:** an address, plus an optional map link you paste.
- A type can offer several; the visitor picks one. Changing a location on a confirmed booking sends an update (`sequence + 1`).

### Abuse and privacy

- **No IPs stored.** Rate limits use `SHA-256(HMAC(IP_SALT, UTC date) : action : network)` with IPv6 grouped by /64, hourly rows deleted after 48 hours (perchlight-forms' method).
- **Holds can't lock your calendar:** 10-minute expiry, at most 2 active holds per network and 20 per deployment, Turnstile on each hold.
- **Spam bookings:** Turnstile; at most 3 upcoming bookings per email address (hashed lookup); daily caps; a block list of addresses and domains (`blocked` table, editable in the desktop app); "cancel and block" for you. Honeypot field as in forms. Approval mode for types that attract junk.
- **Stored:** name, email, optional phone and notes, chosen location, visitor time zone, times, status history (who cancelled, when, reason), consent time if you add a consent question.
- **Not stored:** IP addresses, user agents, cookies, country, Turnstile tokens, and your calendar's event titles (only busy intervals). The Worker sets no cookies.
- **Retention:** `RETENTION_DAYS` after the meeting (default 90; `0` keeps until deleted), personal fields are removed and the row kept as an anonymous "booking happened" record (type, time, status) for counts; set `"retentionMode": "delete"` to delete rows completely. Cells of past times are deleted daily. Delivery rows 90 days.
- **Delete and export on request:** `DELETE /api/bookings?email=` (40 per call, `"more": true` while some remain; `npm run forget`) removes their bookings and cancels any upcoming ones (you're emailed the list so you know which meetings vanished; with an email service, the visitor gets the cancellation). `GET /api/export?email=` first. GDPR principles followed as in perchlight-forms: data minimisation and storage limitation (Art. 5), erasure (Art. 17).
- **Third parties:** Turnstile (Cloudflare), your email service (if used), the video service whose link you paste. Listed in the README for your privacy notice.

### Admin API

`Authorization: Bearer <ADMIN_TOKEN>`.

| Endpoint | What it does |
|---|---|
| `GET /api/config` | Event types, on/off, config errors, feed status, next alarm time. |
| `GET /api/bookings?status=&from=&to=&limit=&cursor=` · `GET /api/bookings/:id` | List / one booking with its deliveries. |
| `PATCH /api/bookings/:id` | Approve / decline a request, set a video link, cancel (as owner), with reason. |
| `POST /api/bookings` | Book on someone's behalf (same constraints, no Turnstile). |
| `GET/POST/DELETE /api/exceptions` | Date exceptions (day off, different hours). |
| `GET/POST/DELETE /api/blocked` | Block list. |
| `GET /api/calendar-check` | Fetch and report on your ICS links now. |
| `GET /api/deliveries?status=failed` · `POST /api/deliveries/:id/retry` | Failed notifications. |
| `DELETE /api/bookings?email=` · `GET /api/export?email=&format=csv|json` | Erasure and export (CSV with formula-safe cells and BOM, as forms). |
| `POST /api/test-notify` · `POST /api/housekeeping` | Test email with `.ics`; run housekeeping now. |

### Data model (D1)

- `bookings`: `id` (`bk_` + 16 random characters), `type_id`, `start_ms`, `end_ms` (UTC), `local_day` (owner's zone, `YYYY-MM-DD`), `status` (`held` | `requested` | `confirmed` | `cancelled` | `declined` | `expired`), `hold_expires_at`, `hold_token_hash`, `request_expires_at`, `name`, `email` (lower-cased, indexed), `phone`, `notes`, `location_key`, `location_detail`, `visitor_tz`, `sequence`, `manage_version` (bumped to revoke all old links), `created_at`, `confirmed_at`, `cancelled_at`, `cancelled_by`, `cancel_reason`, `anonymised_at`. Indexes: `(status, start_ms)`, `(email)`, `(status, hold_expires_at)`.
- `slot_cells`: `cell_ms` **primary key**, `booking_id` (indexed). Present only for `held`, `requested` and `confirmed` bookings.
- `day_counts`: `local_day`, `type_id` (`'*'` for all types), `n`, `cap`, `CHECK (n <= cap)`; primary key `(local_day, type_id)`.
- `exceptions`: `date` (owner's zone), `kind` (`off` | `hours`), `ranges` (JSON), `note`.
- `busy_cache`: `source` (hash of the link, never the link), `fetched_at`, `etag`, `last_modified`, `ok`, `error`, `intervals` (JSON of minute pairs), `stats` (JSON: events, series, unsupported rules, size).
- `deliveries`: as perchlight-forms, with `kind` (`owner_new` | `owner_request` | `owner_cancel` | `visitor_confirm` | `visitor_cancel` | `reminder_owner_1440` ...), `sequence`, `due_at`; unique on `(booking_id, kind, sequence)`.
- `blocked`: `value` (address or `@domain`, lower-cased), `created_at`, `note`.
- `email_counts`: `email_hash`, `day`, `n` (per-address limits; deleted after 2 days).
- `rate_counters`, `daily_counts`, `state` (housekeeping timestamps, retention progress), as perchlight-forms.

### Desktop app screens (`perchlight/perchlight.json`)

- **Upcoming** (`bookings`, `status IN (confirmed, requested)`, future): start, type, name, email, location, status. Actions: *Cancel* (sets `status: cancel_requested`; the next housekeeping run releases cells and sends cancellations, since the app writes D1 directly and can't run the transaction), *Delete* (confirm).
- **Requests** (`status = requested`): *Approve* / *Decline* (`status: approve_requested` / `decline_requested`, processed by housekeeping as above).
- **Days off** (`exceptions`): add, edit, delete.
- **Blocked** (`blocked`) and **Failed notifications** (`deliveries`, *Try again*).

The app writes D1 without waking the Worker, so those buttons take effect at the next housekeeping run; the screen shows `status: approve_requested` until then. A dedicated preset could call the admin API instead (open question 6).

### Edge cases

- **Two visitors, same time, same second:** one batch wins the cell primary key; the other gets 409 with the nearest times. Tested with concurrent requests.
- **Overlapping different lengths** (a 60-minute at 09:30 and a 30-minute at 10:00): both claim the 10:00 cell; one fails. Cells make overlap of any lengths a key clash.
- **Hold expires while typing:** confirm says so and offers to hold again if still free.
- **Expired holds blocking:** their cells are deleted in the same transaction as the next claim on those cells, and by housekeeping.
- **Owner changes hours or adds a day off after bookings exist:** existing bookings stay; `GET /api/config` lists bookings now outside availability so you can cancel or keep them.
- **Config changes a duration:** existing bookings keep their stored end time.
- **D1 write limit reached** (writes blocked until 00:00 UTC on Free): holds fail with a visible 503 and `FALLBACK_CONTACT`; nothing is half-booked. Reminders already due wait (see above).
- **Daily requests over 100,000** (Error 1027): the booking API fails visibly; static pages still load.
- **Feed down:** last good copy up to 24 hours, then bookings pause with a message (above).
- **Your own invite or our UID in your feed:** ignored (above).
- **Turnstile without JavaScript:** no-JS path uses tighter limits or is switched off.
- **Email scanners opening links:** GET pages never change state.
- **Signed links:** `HMAC(LINK_SECRET, id . action . exp . manage_version)`; manage links expire at the meeting's end (+7 days to view), approve links at the request's expiry. Rotating `LINK_SECRET` or bumping `manage_version` revokes them.
- **Visitor in a zone with an unusual offset** (`Asia/Kathmandu` +05:45, `Australia/Lord_Howe` 30-minute DST): handled by instants; tested.
- **Leap seconds, year boundaries, `UNTIL` in a different zone than `DTSTART`:** tested from RFC 5545's RRULE examples.

### Footprint

First estimates, measured during the build.

| | Idle | Per booking (visitor views 3 weeks of slots, books, 2 reminders) | 50 bookings a day |
|---|---|---|---|
| Worker requests (limit 100,000/day) | 0 (static pages are free asset requests; no cron; no alarm without upcoming bookings) | about 6 (slots ×3, hold, confirm, manage view) + Clock: 1 call + about 3 alarm runs | about 500 (0.5%) |
| DO requests (limit 100,000/day, alarms included) | 0 | about 4 | about 200 (0.2%) |
| DO rows written (limit 100,000/day) | 0 | about 4 (`setAlarm`) | about 200 (0.2%) |
| D1 rows written (limit 100,000/day) | 0 | about 30 (booking, 2–5 cells, 2 day counts, 3–6 deliveries and their updates, rate counter, indexes) + feed refreshes (1 row per 10 minutes while people are looking, at most 144 a day) | about 1,650 (1.7%) |
| D1 rows read (limit 5,000,000/day) | 0 | about 150 (each slots call reads that range's cells and exceptions) | about 7,500 (0.2%) |
| Subrequests (limit 50/request) | — | hold: about 6 D1 calls + Turnstile + possibly the ICS fetch; confirm: about 4 D1 + 1–2 emails + 1 DO | — |
| CPU (10 ms/request) | — | slot generation for 14 days: well under 1 ms (estimate); ICS parsing: **unmeasured, the main risk** | — |

Writes would bind first only at around 2,500 bookings a day, far beyond one person's calendar. **What it costs you:** nothing inside the free plans: Workers Free, D1 Free, Durable Objects Free (SQLite backend), Turnstile (free), `send_email` to your own address (free). Visitor emails need an email service; most have a free tier (Resend: 100 a day).

### Payments, later

Out of v0.1 because no payment option is free (Stripe has no monthly fee but takes a fee per payment; others similar), and payments add refunds, receipts, tax and disputes. The design leaves room: a type could have `"payment": { "link": ... }` where a `held` booking (hold extended to 30 minutes) becomes `confirmed` only when a verified webhook (for example Stripe Checkout's `checkout.session.completed`, signature checked) names its id; unpaid holds expire as usual. Cancellation refunds would be manual at first.

## Testing

- **Unit:** config validation; slot generation per weekday, exceptions, holidays, notice, horizon, step, buffers; DST in `Europe/London`, `America/New_York`, `Australia/Lord_Howe`, `Asia/Kolkata` (no DST), `Pacific/Apia`; local-to-UTC conversion at gaps and overlaps; ICS line unfolding and property parsing; RRULE expansion against the examples in RFC 5545 §3.8.5.3; EXDATE, RDATE, RECURRENCE-ID; all-day and transparent events; Windows zone names and VTIMEZONE fallback; unsupported rules over-block; `.ics` output (UID stable, SEQUENCE increases, METHOD, escaping, line folding at 75 octets); MIME building; signed links (expiry, tampering, revocation); rate-limit keys rotate daily.
- **Integration** with vitest and `@cloudflare/vitest-pool-workers` (the Workers pool, local D1 and Durable Objects, as perchlight-forms): hold → confirm; 20 concurrent holds on one time → exactly one wins; overlapping lengths; expired hold freed by the next claim; daily cap `CHECK`; approval → approve / decline / expire; reschedule atomic under a clash; cancel releases cells; Clock alarm sends reminders once even when run twice; lazy fallback sends them with the DO stubbed out; late reminders skipped; D1 write failure → visible 503; Turnstile test keys (pass / fail / spent); feed caching with ETag; feed down → last copy → pause after 24 hours; delete-by-email; no IP in any table.
- **Fixtures:** real ICS exports from a Google, an Outlook.com and an iCloud test calendar (free accounts), with repeating events, moved instances and all-day events, stripped of personal text.
- **With your real account (free):** deploy to a test subdomain, verify your address in Email Routing, connect a test calendar's ICS link, book from a phone, and check the invite in Gmail, Outlook.com and Apple Calendar (accept, reschedule, cancel: does the same event update?). Measure CPU per invocation for feeds of 100 KB, 500 KB, 1 MB, 2 MB to set `FEED_MAX_KB` and decide Plan B.
- **Not tested** (costs money, or needs a paid or card-backed account the authors won't put down):
  - real sends through Resend, SES, Mailgun, Postmark (tested against fakes from their docs, as in perchlight-list); Resend's free tier could be tested by a user with a domain, and the README asks for reports;
  - Cloudflare Email Service to arbitrary addresses (needs Workers Paid);
  - Microsoft 365 / Google Workspace business calendars (paid accounts; admins may block the ICS link);
  - Google free/busy OAuth (v0.2, and possibly Google app verification);
  - payments (out of scope).

## Open questions

All resolved on 2026-11-11: the recommended answer was approved for every one.

1. **Visitor email default.** Resolved: `none` (free, no setup: confirmation page, `.ics` download, manage link), with `provider` / `provider-confirm` for those who connect an email service (Resend etc.), with the anti-abuse caps and the confirm-your-email mode.
2. **ICS parsing location.** Resolved: Plan A (single pass in the Worker with a size cap), measured; Plan B (chunked in the Durable Object) only if measurements require it. Measured in the build (Node 24 / V8 13.6 on the author's PC, not Cloudflare): see "Build notes".
3. **Slot grid.** Resolved: 15 minutes by default, with 5 allowed.
4. **One owner per deployment.** Resolved: yes for v0.1; a second person deploys a second copy.
5. **Retention.** Resolved: personal details removed 90 days after the meeting (the row stays as an anonymous type/time/status record).
6. **Desktop app actions.** Resolved: generic Perchlight screens now, writing `*_requested` statuses that housekeeping carries out; a preset that calls the admin API later.
7. **Where availability lives.** Resolved: event types and weekly hours in `booking.json`; days off (date exceptions) and the block list in D1.
8. **Approval mode default.** Resolved: off, on per event type.
9. **No-JS booking path.** Resolved: on, with tighter limits (2 an hour per network); owners can switch it off.
10. **Hold length.** Resolved: 10 minutes (30 once a visitor submits details in `provider-confirm` mode).

## Build notes (v0.1)

Where the build differs from the text above, and why:

- **ICS CPU, measured (Plan A kept, cap lowered).** `npm run measure` parses generated Google-shaped feeds: 2,000 events (1.1 MB) took a median 7.3 ms (p95 9.8 ms) warm and 35 ms on the first parse in a fresh process; 500 KB took ~3–4 ms warm; 100 KB ~1 ms. The first-parse cost is mostly fixed (16 ms even for 20 events: JIT and `Intl` set-up), not size. This is V8 on a Windows PC, not Cloudflare. So `FEED_MAX_KB` defaults to **512**, not 1,024, and Plan B is not built: whether it's needed depends on CPU time measured on a real Free account (dashboard), which this build couldn't do.
- **Cells are 15 minutes (5 for 5- and 10-minute grids), not `stepMinutes`.** Every zone's offset is a multiple of 15 minutes, so with 15-minute cells any local grid lands on a cell, including a 60-minute grid in `Asia/Kathmandu` (+05:45). Durations and buffers must be multiples of the cell (15), not of the step. With the default 15-minute step it's identical to the SDD.
- **Pages.** The booking page is static (`/` and `/:type` are served by Workers static assets as one page, so page views stay free). The no-JS form (`/nojs/:type`), the manage, reschedule, approve and confirm-your-email pages are rendered by the Worker, since they need data and must work without JavaScript.
- **Erasure doesn't email the visitor.** `DELETE /api/bookings?email=` cancels upcoming bookings without the usual per-booking emails and sends you one list (type and time) instead: emailing the address being erased would mean keeping it.
- **Desktop app.** The Perchlight v1 schema has no row filters and no "add row" action, so the bookings screen shows every status (with Cancel / Approve request / Decline request buttons), and new days off are added with `POST /api/exceptions` (the app can edit and delete them).
- **Owner emails go through `send_email` even when `MAIL_PROVIDER` names an email service** (raw MIME with an inline `text/calendar` part, which the services' JSON APIs can't send); visitor emails use the service, with the `.ics` attached. With `MAIL_PROVIDER=cloudflare` both use the service.
- **Turnstile** is required on holds when `TURNSTILE_SECRET_KEY` is set (recommended, and needed for visitor emails); without it, holds rely on the rate limits. The token's hostname must be the request's host or `PUBLIC_URL`'s.
- **After the first review:** fetching and parsing moved into the Clock Durable Object (visitor requests only read the cache, or wait on the Clock's RPC, which is I/O); full re-parse at least every 12 hours; unusable `CALENDAR_ICS_URLS` entries pause bookings; unsupported rules block whole days; holiday feeds ignore TRANSP; the invite UID host is stored per booking; 3 reschedules a day per booking. Plan B (chunked parsing) is still not built: the measured first-parse cost is fixed (~16 ms even for 20 events), so chunks wouldn't make a cold parse fit 10 ms; DO CPU on Free isn't stated by Cloudflare.
- **Plain `http://localhost` calendar links** are accepted, for local testing only; everything else must be `https://`.

## Couldn't confirm (2026-11-11)

- **Durable Object CPU limit per invocation on Free:** the DO limits page says DOs follow Workers' per-invocation CPU limits but gives no Free figure; it also contradicts itself on Free per-object storage (10 GB in the table, 1 GB in the FAQ). Neither matters for Plan A (the Clock stores almost nothing).
- **Alarms on Free** are implied (the Free pricing table counts "alarm invocations" as requests) but the alarms page doesn't state plan availability.
- **CPU cost of parsing ICS feeds** of realistic sizes within 10 ms.
- **How quickly Google, Outlook and iCloud update their ICS links**, and how often they re-poll a subscribed feed.
- **Outlook's publish detail levels** (exact option names) and **iCloud public calendar** behaviour: not checked against current vendor pages.
- **Calendar apps' handling of invites to the organizer** and of `VALARM` in invites.
- **Temporal API availability in Workers**: the design uses only `Intl.DateTimeFormat`.
- **Google Calendar API quota/price** and whether the `calendar.freebusy` scope needs app verification.
- **SES, Mailgun, Postmark current free tiers**; Calendly's monthly-billed prices; Cal.com's self-hosting licence (believed AGPLv3, not confirmed on its pricing page).
- **`send_email` daily limits** to verified addresses (as in perchlight-forms: free, no stated cap).

## Sources

- Workers limits (10 ms CPU on Free, network waits excluded, 50 subrequests, 100,000 requests/day, 5 cron triggers, 128 MB): https://developers.cloudflare.com/workers/platform/limits/
- Static assets (requests free and unlimited): https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- Durable Objects pricing (Free: SQLite backend only; 100,000 requests/day including alarm invocations; 13,000 GB-s/day; 5M rows read, 100,000 rows written/day; 5 GB; `setAlarm` = 1 row written): https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects alarms (one alarm per object, override, at-least-once, backoff from 2 s, 6 retries): https://developers.cloudflare.com/durable-objects/api/alarms/
- Durable Objects limits (5 GB per account on Free, 100 classes on Free): https://developers.cloudflare.com/durable-objects/platform/limits/
- D1 pricing and limits: https://developers.cloudflare.com/d1/platform/pricing/ · https://developers.cloudflare.com/d1/platform/limits/
- `send_email` and Email Service pricing: https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/ · https://developers.cloudflare.com/email-service/platform/pricing/
- Turnstile server-side validation: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- Google secret iCal address: https://support.google.com/calendar/answer/37648?hl=en
- Outlook publishing: https://support.microsoft.com/en-us/office/introduction-to-publishing-internet-calendars-a25e68d6-695a-41c6-a701-103d44ba151d
- Google Calendar `freebusy.query`: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Resend pricing: https://resend.com/pricing · Calendly: https://calendly.com/pricing · Cal.com: https://cal.com/pricing
- iCalendar RFC 5545 (RRULE, UID, SEQUENCE, VALARM): https://www.rfc-editor.org/rfc/rfc5545 · iTIP RFC 5546 (METHOD REQUEST / CANCEL): https://www.rfc-editor.org/rfc/rfc5546
- CLDR Windows zone mapping: https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml
- GDPR Art. 5 and 17: https://gdpr-info.eu/art-5-gdpr/ · https://gdpr-info.eu/art-17-gdpr/

## Acceptance criteria

- With weekly hours set in `Europe/London`, a visitor in `America/New_York` sees the right times in their zone, including the weeks when only one side has changed clocks; the booking is stored in UTC and shown correctly in both emails.
- A busy event in the owner's Google calendar (including one instance of a weekly series, a moved instance and an excluded date) is never offered as free, within one feed refresh.
- 20 simultaneous holds on the same time give exactly one hold and 19 "just taken" answers with nearest times; a 60-minute and a 30-minute booking can never overlap.
- A hold not confirmed within 10 minutes frees the time without any request from that visitor.
- With approval on, a request holds the time until approved (booking confirmed, invites sent once) or declined / expired (time freed, both sides told where possible).
- The owner's invite opens as an event in Gmail, Outlook.com and Apple Calendar; a reschedule updates the same event (same UID, higher SEQUENCE) and a cancel removes it.
- With `visitorEmail: none`, the visitor's confirmation page gives a working `.ics`, Add-to-calendar links and a manage link that cancels and reschedules; with `provider` (against the fake), the visitor gets confirmation, reminders and cancellation emails once each.
- Reminders arrive about 24 hours and 1 hour before, with no cron trigger, timed by the Clock alarm; with the Clock stubbed out they're sent by the lazy housekeeping on the next request, and never after the meeting started.
- The bookings feed URL, subscribed in a calendar app, shows upcoming bookings; the old URL stops working after `FEED_SECRET` changes.
- An unknown RRULE blocks time (over-blocking) and is reported by `GET /api/calendar-check`.
- No IP address appears in any table; `DELETE /api/bookings?email=` removes or anonymises every booking for that address and cancels upcoming ones.
- With no upcoming bookings and no visitors, it uses no Worker requests, no DO requests and no D1 writes.
