// A per-request budget of binding calls and outbound requests.
// Copied from perchlight-forms src/lib/budget.js; the costs are this Worker's.
//
// Workers Free allows 50 subrequests per request, and D1 documents 50
// queries per invocation. Whether D1, Durable Object and send_email binding
// calls count toward the 50 is NOT confirmed, so this assumes they all do and
// keeps one request (its own work, its notifications and a housekeeping run)
// under 45. Work that doesn't fit is left for the next run (the Clock alarm,
// or the next request's lazy housekeeping).

export const SUBREQUEST_BUDGET = 45;

/** Worst cases, counted by hand from the code. */
export const COST = {
  // hold: rate limit, busy cache read, slot cells + counts read, the batch; Turnstile
  hold: 5,
  turnstile: 1,
  // a calendar refresh: the ICS fetch (per link), the cache write
  feedFetch: 2,
  // confirm: load the hold, block/upcoming checks, the batch
  confirm: 4,
  // cancel / reschedule / approve / decline: load, the batch (+ slots read for reschedule)
  change: 3,
  // waking the Clock Durable Object
  clock: 1,
  // sending: the select of due rows; per delivery: claim, load booking, the send, finish
  deliverySelect: 1,
  delivery: 4,
  // a visitor email's caps
  visitorCaps: 2,
  // housekeeping: throttle claim, stale release + expiry (one batch), state read
  housekeepingBase: 3,
  // one desktop-app request (cancel / approve / decline): select, the batch
  appRequest: 2,
  // retention: anonymise/delete a page, old cells/counters/rows, recount days
  retention: 4,
  stateSave: 1,
  // a public read (slots): config, busy cache, cells, counts, exceptions
  slots: 4,
  admin: 6,
};

export const MIN_UNIT = COST.delivery;

export function newBudget(total = SUBREQUEST_BUDGET) {
  return { left: total };
}

export function left(budget) {
  return budget ? budget.left : Infinity;
}

/** Takes n from the budget if it's there. */
export function spend(budget, n) {
  if (!budget) return true;
  if (budget.left < n) return false;
  budget.left -= n;
  return true;
}
