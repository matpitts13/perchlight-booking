# perchlight-booking

[![CI](https://github.com/matpitts13/perchlight-booking/actions/workflows/ci.yml/badge.svg)](https://github.com/matpitts13/perchlight-booking/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matpitts13/perchlight-booking)

**A "pick a time with me" booking page, on your own Cloudflare account.** You set your event types (for example 15, 30 and 60 minutes), your weekly hours, days off, buffers and limits, in your own time zone. The Worker reads your calendar through its private iCal (ICS) link, so times you're already busy never show as free, and visitors see what's left in their own time zone. Nothing can be double-booked. You get an email with a calendar invite for every booking; the visitor gets a confirmation page with an "Add to calendar" file and a private link to cancel or reschedule.

It replaces Calendly / Cal.com for one person. Calendly's free plan allows one event type; Standard is $10 a seat a month, billed yearly (calendly.com/pricing, checked 2026-11-11). Here the bookings and your visitors' details stay in your Cloudflare account, for as long as you choose, and nothing is a subscription.

Part of [Perchlight](https://github.com/matpitts13/perchlight), a free toolkit for running a product on Cloudflare.

## What it does

- **Event types** in `booking.json`: duration, description, location options (video link you paste, phone, in person), buffer after, minimum notice (default 4 hours), horizon (60 days), daily cap, and "needs my approval" on or off.
- **Your hours in your zone**, several ranges a day; a type's own hours can only narrow yours. **Days off** and "different hours on 5 March" live in D1, so you change them from the [desktop app](#perchlight-desktop-app) or the API without a redeploy. Holidays in `booking.json` (or public-holiday ICS links).
- **Time zones done right**: bookings are stored in UTC, rules are wall-clock time in your zone (an IANA name like `Europe/London`), visitors see times in theirs (detected, changeable). Daylight-saving days are handled: 09:00–17:00 is still 8 real hours on the day clocks change, a time that doesn't exist moves to the first one that does, and the page shows UTC offsets.
- **Busy times from your own calendar** (Google, Outlook, iCloud, anything that publishes ICS), parsed in the Worker with no dependencies: repeating events (RRULE with COUNT, UNTIL, BYDAY like `2TU` / `-1FR`, BYMONTHDAY, BYMONTH, BYSETPOS), excluded and added dates, moved instances, all-day events, IANA, Windows (Outlook) and VTIMEZONE time zones. A repeat rule it can't expand exactly blocks that time every day: too much, never too little.
- **No double booking, ever** (see [ADR 0001](docs/adr/0001-slot-cells-guarded-batches.md)). Picking a time holds it for 10 minutes; confirming turns the hold into a booking. Both are single D1 transactions where a clash on any 15-minute cell rolls everything back, so two visitors can't get the same time and bookings of different lengths can't overlap. The loser sees "that time was just taken" and the nearest free times.
- **Nothing lost silently.** Every attempt ends as a problem the visitor can act on, a hold that expires, a request, a booking, or a cancelled / declined / expired booking with who did it and when.
- **Optional approval** per type: the time is held as a request (48 hours by default) until you approve (optionally pasting a video link) or decline from the link in your email, the API or the desktop app.
- **Correct calendar invites**: one `UID` per booking for its whole life, `SEQUENCE` up on every change, `METHOD:REQUEST` for new and changed bookings and `METHOD:CANCEL` for cancellations, so calendar apps update the same event.
- **Cancel and reschedule links** for the visitor, signed and expiring, no account. A reschedule takes the new time and releases the old one in one transaction, or nothing changes. Links never change anything on a GET (email scanners open links): every change is a button.
- **Reminders without a cron trigger**: 24 hours and 1 hour before (you, and the visitor if an email service is connected), timed by a Durable Object alarm. Never sent after the meeting started.
- **A private feed of your bookings** (`/feed/<FEED_SECRET>.ics`) to subscribe to from any calendar app.
- **Works without JavaScript**: a plain form with times in your zone (with tighter limits, see [The no-JavaScript page](#the-no-javascript-page)).
- **Spam and abuse limits with no IP addresses stored**: Turnstile on every hold, a per-network hourly limit keyed by a daily-rotating salted hash, at most 2 holds at once per network and 20 per deployment, at most 3 upcoming bookings per email address, daily caps, a block list, a honeypot.
- **Privacy**: no IPs, user agents or cookies; personal details removed 90 days after the meeting; erase or export everything for one address in one call.

## Set up

You need a Cloudflare account (free) and Node.js 22+.

### 1. Email to you (free)

Notifications reach you through Cloudflare's free `send_email` binding, which only sends to addresses you've verified. In the Cloudflare dashboard: your domain > **Email** > **Email Routing** > turn it on, and under **Destination addresses** add and verify the address in `owner.email`. Set `MAIL_FROM` in `wrangler.jsonc` to an address on that domain (for example `Bookings <bookings@example.com>`).

### 2. Your calendar's private link

- **Google:** Settings > your calendar > Integrate calendar > **Secret address in iCal format**. Anyone with it can read the calendar; **Reset** makes a new one. A work or school admin may have hidden it.
- **Outlook on the web:** Settings > Calendar > Shared calendars > **Publish a calendar**, pick the calendar and the level of detail (the busy-only level is enough and shares less), publish, and copy the ICS link. Microsoft says anyone with the link can view it.
- **iCloud:** share a calendar as a **Public Calendar** and use its `webcal://` link. This shares full details with anyone who has the link; a separate "busy" calendar avoids that. (Not checked against Apple's current docs.)

Several links can be given, comma-separated; busy times are merged. They're secrets: `npx wrangler secret put CALENDAR_ICS_URLS`.

### 3. `booking.json`

Edit it (see [booking.json](#bookingjson)) and check it: `npm run check`.

### 4. Deploy

```sh
npm ci
npx wrangler d1 create perchlight-booking      # paste the database_id into wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN            # 16+ random characters (openssl rand -hex 32)
npx wrangler secret put LINK_SECRET            # 16+ random characters
npx wrangler secret put IP_SALT                # 16+ random characters
npx wrangler secret put CALENDAR_ICS_URLS      # your private ICS link(s)
npx wrangler secret put FEED_SECRET            # optional: 16+ characters, your bookings feed's path
npx wrangler secret put TURNSTILE_SECRET_KEY   # recommended; and TURNSTILE_SITE_KEY in wrangler.jsonc vars
npm run deploy                                 # applies D1 migrations, then deploys
```

Or use the **Deploy to Cloudflare** button: it creates the D1 database and asks for the secrets listed in `package.json`.

Turnstile: dashboard > **Turnstile** > Add widget, with your Worker's hostname. Put the site key in `TURNSTILE_SITE_KEY` (vars) and the secret with `wrangler secret put`.

### 5. Check it works

- `GET /api/config` with `Authorization: Bearer <ADMIN_TOKEN>`: event types on or off (and why), setup warnings, calendar status, the next alarm, and upcoming bookings now outside your hours.
- `GET /api/calendar-check`: fetches your ICS links now and reports events read, repeating series, moved instances, rules it couldn't fully expand (and how it treated them), time zones it didn't recognise, the feed's size and the busy times for the next 7 days.
- `POST /api/test-notify` (optional body `{ "visitor": "you@example.org" }`): a sample booking email with its invite, so you can see it land in your calendar app before a real visitor books.
- Open `https://<your worker>/30min` and book a time.

## booking.json

```jsonc
{
  "owner": {
    "name": "Sam Example",
    "email": "sam@example.com",           // send_email: verified in Email Routing
    "timeZone": "Europe/London",          // IANA name; all rules are in this zone
    "weekly": { "mon": [["09:00", "12:00"], ["13:00", "17:00"]], "tue": [["09:00", "17:00"]], "wed": [], ... },
    "holidays": ["2026-12-25"],
    "holidayFeeds": [],                   // public-holiday ICS links: their days are off
    "dailyCap": 6                         // all types together, per day in your zone
  },
  "defaults": { "minNoticeHours": 4, "horizonDays": 60, "bufferAfterMinutes": 15, "stepMinutes": 15,
                "holdMinutes": 10, "requestHours": 48, "reminders": [1440, 60] },
  "types": {
    "30min": { "name": "Call", "minutes": 30, "locations": ["video", "phone"], "dailyCap": 4 },
    "60min": { "name": "Workshop", "minutes": 60, "locations": ["in-person"], "approval": true,
               "minNoticeHours": 48, "weekly": { "tue": [["10:00", "16:00"]] } }
  },
  "locations": {
    "video": { "kind": "video", "link": "https://meet.example.com/sam" },
    "phone": { "kind": "phone", "who": "visitor-gives-number" },   // or "owner-number" with "number"
    "in-person": { "kind": "in-person", "address": "1 Example Street, London", "map": "https://..." }
  },
  "questions": { "phone": "optional", "notes": "optional" },          // or "required" / "off"
  "visitorEmail": "none",               // "none" | "provider" | "provider-confirm"
  "noJs": true,                         // the no-JavaScript page
  "allDayEvents": "busy",               // or "ignore" (calendars full of busy all-day reminders)
  "retentionMode": "anonymise",         // or "delete"
  "ownerInvite": "request",             // or "attach-only": the .ics attached, no inline invite part
  "limits": { "holdsPerHour": 10, "noJsPerHour": 2, "activeHoldsPerNetwork": 2, "activeHolds": 20,
              "upcomingPerEmail": 3, "visitorEmailsPerAddressPerDay": 2, "visitorEmailsPerDay": 50 }
}
```

- `stepMinutes` (5, 10, 15, 20, 30 or 60) is the grid slots start on. Time is claimed in 15-minute cells (5-minute cells for 5- and 10-minute grids), so durations, buffers and hours must be multiples of 15 (or 5). `npm run check` says so.
- A type with a mistake is switched off (its page says "this booking type isn't set up correctly"); the others keep working. `GET /api/config` names the mistake.
- The event type's id is its page: `/30min`. Slugs `api`, `b`, `r`, `v`, `feed`, `tick`, `nojs` (and a few others) are reserved.
- Changing hours or adding a day off never moves or cancels existing bookings; `GET /api/config` lists the ones now outside your availability.

Global settings are `vars` in `wrangler.jsonc`: `PUBLIC_URL`, `MAIL_FROM`, `MAIL_PROVIDER`, `VISITOR_MAIL_FROM`, `FEED_MINUTES` (10), `FEED_MAX_KB` (512), `RETENTION_DAYS` (90), `FALLBACK_CONTACT`, `HOUSEKEEPING_MINUTES` (5), `TURNSTILE_SITE_KEY`.

## Your calendar, and what it can't promise

- The ICS link is read when someone looks at times and the copy is over `FEED_MINUTES` old (the visitor is answered from the copy; the refresh runs after the reply). An unchanged feed costs no parsing (`If-None-Match` / `If-Modified-Since`).
- **Before a hold**, the copy must be under 30 minutes old, or the hold waits for a refresh.
- If the link can't be read, the last good copy is used for up to 24 hours. After that the page says "bookings are paused while the calendar can't be read", and you're emailed once.
- A feed over `FEED_MAX_KB` (512 KB) is refused, never cut short: bookings pause and `GET /api/calendar-check` says why. Use Outlook's busy-only link, or a smaller calendar. See [What it costs](#what-it-costs) for why 512.
- **An event you add to your own calendar** is only seen once your provider updates the ICS link and the copy refreshes; how fast Google, Outlook and iCloud do that isn't documented. So a clash with something you added a few minutes ago is possible. A clash between two bookings made here is not.
- Only busy intervals are kept: no titles, descriptions or attendees leave the parser. Your own booking invites (UID ending `@<your worker host>`) are ignored, so a booking never blocks its own reschedule.

## No cron trigger: how reminders and clean-up run

The free plan allows 5 cron triggers per account and the rest of the Perchlight family uses 4, so this uses none.

- **The Clock**, a Durable Object (SQLite backend, on the Free plan) holding only one alarm: the next due time (a hold or request expiring, a reminder, a retry). After any change, the Worker asks it to wake at the new due time; it sets the alarm only if that's earlier, so it's usually one DO request and one row written per booking. When it fires, it sends what's due (claim-then-send, so an at-least-once alarm never sends twice), expires holds and requests, runs retention, and sets the next alarm. With nothing due, no alarm is set: idle costs nothing.
- **Lazy fallback**, as in perchlight-forms: the same housekeeping runs after public and admin requests and `GET /tick`, at most every `HOUSEKEEPING_MINUTES`. If the Clock were unavailable, reminders would be late until someone visits, never lost, and never sent after the meeting started (they're marked "skipped").
- An uptime monitor hitting `GET /tick` every few minutes is optional insurance.

## Emails to visitors

`send_email` only reaches addresses you've verified, and Cloudflare's Email Service needs Workers Paid for arbitrary addresses. So **the free setup can't email the visitor** (`"visitorEmail": "none"`, the default). They still get everything on the confirmation page: the details, an `.ics` download (`METHOD:PUBLISH`), "Add to Google Calendar" and "Outlook" links, and the manage link ("bookmark this page"). If you cancel, their manage page shows it; if they cancel after adding it to their calendar, the page reminds them to remove it.

To email visitors, connect an email service (`MAIL_PROVIDER` = `resend`, `ses`, `mailgun`, `postmark` or `cloudflare`, with its secrets, on a domain you verify with it) and set `"visitorEmail"`:

- `"provider"`: confirmation, change, cancellation and reminder emails with `.ics` (`REQUEST` / `CANCEL`). Resend's free plan allows 100 emails a day, 3,000 a month (resend.com/pricing, checked 2026-11-11); at about 4 emails a booking that's ~25 bookings a day.
- `"provider-confirm"` (recommended where strangers book): the booking stays a hold (30 minutes) until the visitor clicks the link in the first email, so nobody can book under someone else's address. The no-JavaScript page is off in this mode.

Anyone can type a stranger's address, so: visitor emails are only sent for bookings that passed Turnstile (never from the no-JavaScript page); the text is fixed (your text, the time, the place, the links) and the visitor's name is the only thing they typed that appears (60 characters, links removed); at most 2 confirmation emails per address per day (by keyed hash); at most 50 visitor emails a day per deployment. An email whose outcome is unknown (a timeout) is never retried, so nobody gets two. Emails to you still go through the free `send_email` binding.

## The no-JavaScript page

`/nojs/<type>` lists times in your zone ("times in London time") as a plain form; posting it holds and confirms in one request and lands on the manage page. There's no Turnstile on that path, so it's held to 2 bookings an hour per network (`limits.noJsPerHour`), the other limits still apply, and its bookings never email the visitor. Turn it off with `"noJs": false`. The JavaScript page links to it in a `<noscript>`.

## Admin API

Everything under `/api/` except `types`, `slots`, `hold` and `confirm` needs `Authorization: Bearer <ADMIN_TOKEN>` (16+ characters, compared in constant time).

| Endpoint | What it does |
|---|---|
| `GET /api/config` | Types on/off and why, setup warnings, calendar status, next alarm, bookings outside your hours. |
| `GET /api/bookings?status=&from=&to=&limit=&cursor=` · `GET /api/bookings/:id` | List / one booking with its notifications and manage link. |
| `PATCH /api/bookings/:id` | `{ "action": "approve" \| "decline" \| "cancel" \| "location", "link"?, "reason"?, "block"? }`. `"block": true` with cancel adds the address to the block list. |
| `POST /api/bookings` | Book on someone's behalf: `{ type, start (UTC ISO), name, email, location, ... }`, same constraints, no Turnstile (`"ignoreRules": true` to book outside your hours). |
| `GET/POST/DELETE /api/exceptions` | Days off: `{ "date": "2026-03-04", "kind": "off" }` or `{ "kind": "hours", "ranges": [["10:00", "12:00"]] }`; `DELETE ?date=`. |
| `GET/POST/DELETE /api/blocked` | Block list: `{ "value": "someone@example.com" }` or `"@example.com"`; `DELETE ?value=`. |
| `GET /api/calendar-check` | Fetch and report on your ICS links now. |
| `GET /api/deliveries?status=failed` · `POST /api/deliveries/:id/retry` | Failed notifications; try one again. |
| `GET /api/export?email=&format=csv\|json` | Everything for one address (CSV opens in Excel with accents intact; no cell runs as a formula). `npm run export`. |
| `DELETE /api/bookings?email=` | Erase one address: 40 bookings a call, `"more": true` while some remain. Upcoming ones are cancelled first (their time is freed); personal details are removed (or rows deleted with `"retentionMode": "delete"`); you're emailed the list of cancelled meetings; the visitor isn't emailed. `npm run forget`. |
| `POST /api/test-notify` · `POST /api/housekeeping` | A sample email with its invite; run housekeeping now. |

Public: `GET /api/types`, `GET /api/slots?type=&from=&to=` (UTC instants, at most 14 days a call), `POST /api/hold` `{ type, start, turnstile }`, `POST /api/confirm` `{ holdId, token, name, email, phone?, notes?, location, timeZone }`. The API only ever accepts UTC instants, never local times.

## Perchlight desktop app

`perchlight/perchlight.json` adds screens to the [Perchlight](https://github.com/matpitts13/perchlight) desktop app (replace `YOUR-D1-DATABASE-ID`): **Bookings** (with Cancel, Approve request, Decline request, Delete), **Days off and different hours** (edit, delete), **Blocked addresses**, **Booking notifications** (Try again) and **Bookings per day**.

The app writes D1 directly and can't run a transaction, so its Cancel / Approve / Decline buttons set `cancel_requested` / `approve_requested` / `decline_requested`, and the next housekeeping run does the real change (releases the time, sends the emails). Until then the screen shows that status; `POST /api/housekeeping` makes it happen now. The app's format has no filters or "add row" yet, so the Bookings screen shows every status, and new days off are added with `POST /api/exceptions`.

## Privacy

- **Stored:** name, email, optional phone and notes, chosen location, the visitor's time zone, times, and status history (who cancelled, when, why).
- **Not stored:** IP addresses, user agents, cookies, country, Turnstile tokens, your calendar's event titles (only busy intervals), your calendar links (only a hash). The Worker sets no cookies. Rate limits use `SHA-256(HMAC(IP_SALT, UTC date) : action : network)`, IPv6 grouped by /64, rows deleted after 48 hours.
- **Retention:** personal details are removed `RETENTION_DAYS` (90) after the meeting and the row kept as an anonymous "booking happened" record (type, time, status), or deleted with `"retentionMode": "delete"`. Past cells and day counts are deleted daily, notification rows after 90 days.
- **Erasure and export** per address (above), following GDPR's data minimisation and storage limitation (Art. 5) and erasure (Art. 17).
- **Third parties** for your privacy notice: Cloudflare (hosting, Turnstile), your email service if you connect one, and the video service whose link you paste.
- The bookings feed contains visitors' names and emails, so treat `FEED_SECRET` like a password; changing it turns the old link off.

## What it costs

Nothing inside the free plans: Workers Free, D1 Free, Durable Objects Free (SQLite backend), Turnstile, `send_email` to your own address. Visitor emails need an email service (most have a free tier). First estimates (not yet measured on a real account):

| | Idle | Per booking (3 weeks of slots viewed, booked, 2 reminders) | 50 bookings a day |
|---|---|---|---|
| Worker requests (100,000/day) | 0 (pages are free static assets; no cron; no alarm without upcoming bookings) | ~6 + Clock alarm runs | ~500 (0.5%) |
| DO requests (100,000/day) | 0 | ~4–6 | ~300 (0.3%) |
| D1 rows written (100,000/day) | 0 | ~30 + calendar refreshes (≤1 per 10 minutes while people look) | ~1,650 (1.7%) |
| D1 rows read (5,000,000/day) | 0 | ~150 | ~7,500 (0.2%) |

**CPU, the open risk.** Workers Free allows 10 ms of CPU per request; waiting on the calendar fetch doesn't count, parsing does. `npm run measure` parses generated feeds shaped like a personal Google export (mostly past one-off events with descriptions and attendees, some future ones, weekly and monthly series with exceptions). Measured on 2026-11-11 in Node 24.15 (V8 13.6) on a Windows x64 PC, **not on Cloudflare**:

| Feed | Warm parse (median / p95) | First parse in a fresh process |
|---|---|---|
| 100 KB (177 events) | 0.7–1.0 ms / 0.9–1.4 ms | 20 ms |
| 500 KB (900 events) | 3.0–3.9 ms / 3.3–5.2 ms | 28 ms |
| 1 MB (1,840 events) | 6.5 ms / 7.2 ms | — |
| 1.1 MB (2,000 events) | 7.3 ms / 9.8 ms | 35 ms |
| 2 MB (3,670 events) | 13 ms / 13.4 ms | — |

The first-parse cost is mostly fixed (16 ms even for 20 events: compiling the code and setting up `Intl`), not size. That's why `FEED_MAX_KB` defaults to 512: warm, a 500 KB feed takes about a third of the budget. Whether Cloudflare's isolates are usually warm for this, and whether its CPU is faster or slower than this PC, is exactly what needs measuring on a real account (dashboard > Workers > your Worker > Metrics > CPU time). If normal calendars need more than 512 KB and the CPU time doesn't fit, the SDD's Plan B (parse in chunks in the Durable Object) is the next step.

## Tested, and not tested

- `npm test`: 109 tests with vitest and the Workers pool (local D1 and the Clock Durable Object), against a fake `send_email`, a fake Turnstile, a fake Resend and fake calendar feeds. They cover:
  - slot generation per weekday, lunch gaps, exceptions (day off, different hours), holidays, minimum notice, horizon, step, buffers (calendar busy times padded both sides), per-type and overall daily caps, a type's hours narrowing yours
  - time zones: London's spring-forward gap and fall-back overlap, New York, Kolkata, Kathmandu (+05:45, with a 60-minute grid), Lord Howe (30-minute DST), Apia; a New York visitor in the weeks when only one side has changed clocks; ranges across a gap keep their real length
  - ICS parsing: line unfolding, quoted parameters, RFC 5545's RRULE examples (daily, every other day, every other week, WKST, first Friday, second-to-last Monday, third-to-last day, last work day with BYSETPOS, June and July, Friday the 13th, election day, the 30th of February), DST-stable weekly meetings, UNTIL in UTC with DTSTART in New York, 29 February, year boundaries, fast-forwarding old series, EXDATE / RDATE / PERIOD / moved and cancelled instances, all-day and free events, Windows, Mozilla-style and VTIMEZONE zones, unknown zones reported, unsupported rules over-blocking, the 5,000-step cap, our own invites ignored, a Google-style export fixture, the size cap (body and `Content-Length`), no link in errors
  - double booking: 20 simultaneous holds on one time (exactly one wins, 19 get the nearest times), 60- and 30-minute overlap, expired holds freed in the next claim's batch, the daily cap's CHECK, the same hold confirmed twice at once, a reschedule racing a hold, a double cancel
  - holds and confirms: hold expiry while typing (and whether the time is still free), wrong token, used holds, field errors, honeypot, block list (addresses and domains), upcoming-per-address cap, rate limits (from memory too), holds at once per network and per deployment, Turnstile failed / unreachable / wrong hostname, local times and off-grid starts refused, D1 down giving a 503 that names `FALLBACK_CONTACT`
  - manage links: GET changes nothing, tampered / wrong-booking / revoked / expired links refused, cancel (cells, counts, reasons, CANCEL invite, reminders skipped), reschedule atomic with a clash changing nothing, moves across days, no cancelling after the start; `.ics` with a stable UID, SEQUENCE up, PUBLISH then CANCEL
  - approval: approve page is a button, approve with a video link sends the invite once, decline, expiry releasing the time and telling you
  - visitor emails (fake Resend): confirmation with a REQUEST `.ics`, reminders, CANCEL, once each; 2 per address per day; unknown outcomes not retried; never for no-JS bookings; confirm-your-email holding for 30 minutes until a POST from the link's page
  - the Clock: wake keeps the earlier alarm, an alarm run sends a reminder once even when run twice, expires an unconfirmed hold, idle means no Clock calls; the lazy fallback with the Clock missing; reminders never after the start (also when retries would run late); retries after 1 minute with the Clock woken; the housekeeping throttle
  - the desktop app's requested statuses carried out, and never released twice
  - your calendar: busy times never offered and refused at hold time, caching with ETag (304), feed down: last copy for 24 hours, then paused with one email to you; calendar-check reporting unsupported rules without showing the link
  - retention after 90 days, export (CSV with BOM, formula-safe) and erasure, no IP address in any table, admin auth, the bookings feed (wrong or changed secret is a 404), owner-zone vs visitor-zone emails, HTML escaping, MIME header injection (CR/LF, RFC 2047), invite escaping and 75-octet folding, signed links, daily-rotating rate keys
- **Locally with `wrangler dev`, on 2026-11-11** (free, no account; local D1, local Durable Object, a local server serving `test/fixtures/google-e2e.ics`, a Google-style export with a weekly series, an excluded date, a moved instance, a busy and a free all-day event): the page loaded at `/30min` (static); `/api/slots` left out the weekly meeting, the dentist, the busy all-day day, the moved-to time and its buffers, and offered the excluded date, the moved-from time and the free all-day day; a hold and confirm through the API (as the JavaScript page does) gave a manage page in the visitor's zone (New York), a second hold on the same time got 409 with the nearest times; the `.ics` download kept its UID with SEQUENCE 0, then 1 after a reschedule through the page's form, then `METHOD:CANCEL` / SEQUENCE 2 after cancelling; the no-JavaScript form showed times in London time with no script and its POST got a 303 to the manage page; the bookings feed listed the live booking with no METHOD; a wrong feed secret got 404; `/api/config` and `/api/calendar-check` worked and the API refused a request without the token. The four owner emails written by the local `send_email` binding were `multipart/mixed` with an inline `text/calendar; method=REQUEST` part and an `invite.ics` attachment, RFC 2047 subjects ("Zoë") and `Reply-To` set to the visitor.
- **Not tested on a real Cloudflare account yet** (free, but needs you): delivery to a verified Email Routing address; how Gmail, Outlook.com and Apple Calendar treat the invite (does a reschedule update the same event? a cancel remove it? your own copy as organizer?); a real Turnstile widget (Cloudflare's test keys cover pass and fail); the Clock's alarm on the real network; real Google, Outlook and iCloud ICS links; **CPU time per request on the Free plan** for feeds of 100 KB to 2 MB (the measurements above are local V8 only); the footprint table.
- **Not tested, because it costs money or needs a card:**
  - real sends through Resend, SES, Mailgun and Postmark (only against fakes built from their docs, as in perchlight-list); Resend's free tier could be tested by anyone with a domain, and reports are welcome
  - Cloudflare Email Service to arbitrary addresses (needs Workers Paid)
  - Microsoft 365 / Google Workspace business calendars (admins may block the ICS link)
  - payments and Google free/busy OAuth (out of scope for v0.1)

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Cloudflare, Google, Microsoft or Apple.
