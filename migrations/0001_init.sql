-- perchlight-booking: bookings, the slot cells that make double booking
-- impossible, day counts with their caps, notifications, and small state.
-- Times the Worker compares are Unix milliseconds (UTC); *_at TEXT columns
-- are "YYYY-MM-DD HH:MM:SS" UTC (like datetime('now')) for the desktop app.
-- No IP addresses, user agents or cookies are stored anywhere.

-- status:
--   held       a visitor picked the time and is typing (hold_expires_at)
--   requested  waiting for your approval (request_expires_at)
--   confirmed  booked
--   cancelled / declined / expired   finished; cells and counts released
--   cancel_requested / approve_requested / decline_requested
--              set by the Perchlight desktop app; the next housekeeping run
--              does the real change (it releases cells and sends emails)
CREATE TABLE bookings (
  id                 TEXT PRIMARY KEY,
  type_id            TEXT NOT NULL,
  start_ms           INTEGER NOT NULL,
  end_ms             INTEGER NOT NULL,
  claim_end_ms       INTEGER NOT NULL,           -- end + buffer after (the cells claimed)
  local_day          TEXT NOT NULL,              -- your zone, YYYY-MM-DD
  start_at           TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('held', 'requested', 'confirmed', 'cancelled', 'declined', 'expired',
                                                     'cancel_requested', 'approve_requested', 'decline_requested')),
  hold_expires_at    INTEGER,
  hold_token_hash    TEXT,                       -- SHA-256 of the hold token; the token itself is never stored
  net_hash           TEXT,                       -- daily-rotating keyed hash of the network (never an IP), while held
  request_expires_at INTEGER,
  verify_pending     INTEGER NOT NULL DEFAULT 0, -- "confirm your email": waiting for the visitor's click
  name               TEXT,
  email              TEXT,                       -- lower-cased
  phone              TEXT,
  notes              TEXT,
  location_key       TEXT,
  location_detail    TEXT,                       -- e.g. a video link set when you approve
  visitor_tz         TEXT,
  turnstile          TEXT NOT NULL DEFAULT 'off' CHECK (turnstile IN ('passed', 'off')),
  via                TEXT NOT NULL DEFAULT 'page' CHECK (via IN ('page', 'nojs', 'owner')),
  sequence           INTEGER NOT NULL DEFAULT 0, -- the invite's SEQUENCE
  manage_version     INTEGER NOT NULL DEFAULT 1, -- bump to revoke every link to this booking
  op                 TEXT,                       -- nonce of the last guarded change (see src/lib/bookings.js)
  created_at         TEXT NOT NULL,
  created_ms         INTEGER NOT NULL,
  confirmed_at       TEXT,
  cancelled_at       TEXT,
  cancelled_by       TEXT,                       -- visitor | owner | system
  cancel_reason      TEXT,
  anonymised_at      TEXT
);
CREATE INDEX bookings_status_start ON bookings (status, start_ms);
CREATE INDEX bookings_email ON bookings (email);
CREATE INDEX bookings_status_hold ON bookings (status, hold_expires_at);
CREATE INDEX bookings_status_request ON bookings (status, request_expires_at);
CREATE INDEX bookings_day ON bookings (local_day);
CREATE INDEX bookings_end ON bookings (end_ms);

-- One row per claimed cell (15 minutes on the default grid). cell_ms is the
-- primary key, so two claims on the same cell can't both exist: that's what
-- makes double booking impossible, for any mix of lengths.
CREATE TABLE slot_cells (
  cell_ms    INTEGER PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE
);
CREATE INDEX slot_cells_booking ON slot_cells (booking_id);

-- Bookings per local day (your zone) per type, and '*' for all types; the
-- cap travels with the row and CHECK (n <= cap) fails the whole batch.
CREATE TABLE day_counts (
  local_day TEXT NOT NULL,
  type_id   TEXT NOT NULL,
  n         INTEGER NOT NULL DEFAULT 0,
  cap       INTEGER NOT NULL,
  PRIMARY KEY (local_day, type_id),
  CHECK (n <= cap)
);

-- Date exceptions in your zone: a day off, or different hours on one date.
-- ranges: JSON [[startMinute, endMinute], ...] for kind 'hours'.
CREATE TABLE exceptions (
  date       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('off', 'hours')),
  ranges     TEXT,
  note       TEXT,
  created_at TEXT NOT NULL
);

-- Busy times read from your calendar's ICS link(s). source is a hash of the
-- link, never the link. intervals: JSON [[startMinute, endMinute], ...].
CREATE TABLE busy_cache (
  source        TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'calendar' CHECK (kind IN ('calendar', 'holiday')),
  fetched_at    INTEGER NOT NULL DEFAULT 0, -- last attempt
  ok_at         INTEGER NOT NULL DEFAULT 0, -- last good copy
  etag          TEXT,
  last_modified TEXT,
  ok            INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  intervals     TEXT NOT NULL DEFAULT '[]',
  stats         TEXT
);

-- One row per notification (booking, kind, sequence). Claim-then-send, as
-- perchlight-forms. booking_id '' = a notice that isn't about one booking.
-- kind: owner_new | owner_request | owner_change | owner_cancel | owner_expired |
--   visitor_confirm | visitor_verify | visitor_request | visitor_change | visitor_cancel |
--   reminder_owner_<minutes> | reminder_visitor_<minutes> | owner_paused
CREATE TABLE deliveries (
  id              TEXT PRIMARY KEY,
  booking_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  sequence        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'failed', 'unknown', 'skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  due_ms          INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  claimed_at      INTEGER,
  created_ms      INTEGER NOT NULL,
  sent_at         TEXT,
  last_error      TEXT,
  UNIQUE (booking_id, kind, sequence)
);
CREATE INDEX deliveries_due ON deliveries (status, next_attempt_at);
CREATE INDEX deliveries_booking ON deliveries (booking_id);

-- Block list: an address or "@domain", lower-cased.
CREATE TABLE blocked (
  value      TEXT PRIMARY KEY,
  note       TEXT,
  created_at TEXT NOT NULL
);

-- Per-address visitor email limits, by keyed hash of the address. Kept 2 days.
CREATE TABLE email_counts (
  email_hash TEXT NOT NULL,
  day        TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email_hash, day)
);

-- Rate limit: a hash whose key changes every day, never an IP. Kept 48 hours.
CREATE TABLE rate_counters (
  key   TEXT NOT NULL,
  hour  TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, hour)
);

-- Per UTC day. kind: visitor_email (deployment-wide cap) and refusal counts.
CREATE TABLE daily_counts (
  day   TEXT NOT NULL,
  kind  TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

-- Housekeeping state (no cron trigger: the Clock alarm and lazy runs).
CREATE TABLE state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO state (key, value) VALUES ('last_run', '0'), ('last_retention', '0'), ('retention_errors', '{}'), ('paused_since', '0');
