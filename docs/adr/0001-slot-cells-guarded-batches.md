# ADR 0001: No double booking through D1 slot cells and guarded batches

**Date:** 2026-11-11
**Status:** Accepted

## Context

The one promise a booking page can't break is "two people never get the same time". Here it has to hold with:

- many Worker isolates answering at once, in different places, with no shared memory;
- bookings of different lengths (15, 30, 60 minutes) plus a buffer after each, so overlap isn't "same start time";
- holds that expire on their own while a visitor types, requests that expire after 48 hours, reschedules that must take the new time and release the old one together, cancellations, and the desktop app writing D1 directly;
- the free plans: D1 Free (100,000 rows written a day), Durable Objects Free (SQLite backend only), 10 ms of CPU and 50 subrequests per request;
- D1's batches being single transactions: if one statement fails, the whole batch rolls back. D1 has no interactive transactions (no `BEGIN`, read, decide, `COMMIT` across calls).

"Nothing lost or double-booked silently" also means every attempt must end as something the visitor or the owner can see.

## Options considered

1. **Check, then insert.** Read the bookings that overlap, insert if none. Pros: simplest SQL. Cons: two requests can both read "free" before either writes; with no interactive transactions in D1 the gap can't be closed. Rejected: it double-books under load.
2. **One Durable Object serialising every booking.** All holds and confirms go through one object, which checks and writes in order. Pros: a single writer makes the check-then-write race impossible; easy to reason about. Cons: every booking depends on one object being reachable (a DO request and its latency on every hold); the data would live in the DO's storage, where the desktop app (which reads D1) can't see it, or be written twice; DO requests on Free count against their own 100,000 a day.
3. **A row per booked interval with an exclusion check.** SQLite has no exclusion constraints on ranges, so overlap would still be checked by a query first. Same race as option 1.
4. **Slot cells with a primary key, inside guarded batches (chosen).** Time is cut into fixed cells (15 minutes on the default grid). A hold claims every cell from its start to its end plus its buffer, as rows in `slot_cells` whose primary key is the cell's UTC instant. Day caps are `day_counts` rows that carry their cap with `CHECK (n <= cap)`. The hold, its cells and its counts go in one D1 batch; any clash fails a constraint and rolls the whole batch back. Every later change (confirm, reschedule, cancel, approve, decline) is also one batch whose first statement stamps the booking with a fresh nonce only if it's still in the expected state (status, sequence, token, not expired), and whose other statements run only `WHERE EXISTS` that nonce.

## Decision

Option 4.

- Overlap of any lengths becomes a key clash: a 60-minute booking at 09:30 and a 30-minute one at 10:00 both need the 10:00 cell.
- Only a buffer *after* is claimed, so back-to-back bookings with enough gap don't collide; busy times from the owner's calendar are padded on both sides when slots are offered.
- Cells are 15 minutes (5 for 5- and 10-minute grids) rather than one step: every zone's offset is a multiple of 15 minutes, so any local grid (even a 60-minute one in Kathmandu, +05:45) lands on cells.
- Expired holds and requests never block anyone: every claiming batch starts by expiring them (counts down, cells deleted, status set) in the same transaction, so nothing depends on a timer having run first. The Clock alarm and lazy housekeeping do the same work for visibility, not for correctness.
- Guarded batches make every change all-or-nothing and safe against races with other tabs, an expiry, or the desktop app: if the booking moved on, the batch changes nothing and the caller says so ("this booking changed meanwhile", "your hold ran out", 409 with the nearest free times).

## Consequences

- **Correctness doesn't depend on timing or on the Durable Object.** Tested with 20 simultaneous holds on one time (exactly one wins), a reschedule racing a hold for the same time, the same hold confirmed twice at once, and a double cancel.
- **Writes per booking:** 2–5 cell rows plus 2 count rows on top of the booking and its notifications, about 30 rows written per booking end to end; D1 Free's 100,000 a day would bind first at around 2,500 bookings a day.
- **Rule changes don't move existing bookings:** a booking keeps its cells and stored end time if you change hours or durations; `GET /api/config` lists upcoming bookings now outside your availability.
- **The desktop app can't run a batch,** so its buttons write `cancel_requested` / `approve_requested` / `decline_requested` and housekeeping performs the guarded change. If the app deletes a booking row, its cells go with it (foreign key cascade) and the hourly recount fixes the day counts.
- **Only bookings made here are guaranteed not to clash.** Your own calendar is read through its ICS link, which providers refresh on their own schedule: a clash with an event you added a few minutes ago is possible and documented; a clash between two bookings made here is not.
- **Revisit** if D1 gains interactive transactions or range constraints, or if a team feature (several owners) needs cross-calendar locking, where one Durable Object per owner might become the simpler design.
