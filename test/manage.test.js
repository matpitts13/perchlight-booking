import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resetAll, mockFetch, postJson, getJson, call, book, rows, fakeEmail, visitor, NOW, MIN, HOUR, DAY, setNow, postForm, RESEND, api } from "./helpers.js";
import { runHousekeeping } from "../src/lib/housekeeping.js";
import { appFor } from "./helpers.js";
import { approveUrl } from "../src/lib/links.js";
import { PROVIDER_CONFIG } from "./config.js";

const TUE_0900 = "2026-03-03T09:00:00.000Z";
const path = (url) => url.replace("https://booking.test", "");
const tokenOf = (url) => new URL(url).searchParams.get("t");

describe("manage links", () => {
  beforeEach(resetAll);

  it("the manage page shows the booking and changes nothing (scanners open links)", async () => {
    mockFetch();
    const { confirm } = await book(TUE_0900);
    const before = await rows("SELECT * FROM bookings");
    const page = await call(path(confirm.data.manageUrl));
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("Booked.");
    expect(html).toMatch(/Tuesday,? 3 March 2026.*04:00/); // in the visitor's zone (New York)
    expect(html).toContain("https://meet.example.com/sam");
    expect(html).toContain("calendar.google.com/calendar/render");
    expect(html).toContain("outlook.live.com");
    expect(html).toContain("remove it from your calendar");
    expect(await rows("SELECT * FROM bookings")).toEqual(before);
  });

  it("refuses tampered, wrong-booking and revoked links", async () => {
    mockFetch();
    const { confirm } = await book(TUE_0900);
    const url = new URL(confirm.data.manageUrl);
    const t = url.searchParams.get("t");
    expect((await call(`${url.pathname}?t=${t.slice(0, -1)}0`)).status).toBe(404);
    expect((await call(`/b/bk_aaaaaaaaaaaaaaaa?t=${t}`)).status).toBe(404);
    await env.DB.prepare("UPDATE bookings SET manage_version = manage_version + 1").run();
    expect((await call(path(confirm.data.manageUrl))).status).toBe(404);
  });

  it("links expire 7 days after the meeting ends", async () => {
    mockFetch();
    const { confirm } = await book(TUE_0900);
    setNow(Date.parse(TUE_0900) + 30 * MIN + 7 * DAY + MIN);
    expect((await call(path(confirm.data.manageUrl))).status).toBe(404);
  });

  it("the .ics download: same UID always, PUBLISH while booked, CANCEL (higher SEQUENCE) once cancelled", async () => {
    mockFetch();
    const { confirm } = await book(TUE_0900);
    const id = confirm.data.bookingId;
    const t = tokenOf(confirm.data.manageUrl);
    const ics1 = await (await call(`/b/${id}/invite.ics?t=${t}`)).text();
    expect(ics1).toContain("METHOD:PUBLISH");
    expect(ics1).toContain(`UID:${id}@booking.test`);
    expect(ics1).toContain("SEQUENCE:0");
    expect(ics1).toContain("DTSTART:20260303T090000Z");
    const c = await postForm(`/b/${id}/cancel`, { t, reason: "Can't make it" });
    expect(c.status).toBe(200);
    expect(await c.text()).toContain("Cancelled.");
    const ics2 = await (await call(`/b/${id}/invite.ics?t=${t}`)).text();
    expect(ics2).toContain("METHOD:CANCEL");
    expect(ics2).toContain(`UID:${id}@booking.test`);
    expect(ics2).toContain("SEQUENCE:1");
    expect(ics2).toContain("STATUS:CANCELLED");
  });

  it("cancel releases cells and counts, records who and why, sends the owner a CANCEL, skips reminders", async () => {
    mockFetch();
    const email = fakeEmail();
    const { confirm } = await book(TUE_0900, { envOverrides: { EMAIL: email.binding } });
    const r = await postJson(`/b/${confirm.data.bookingId}/cancel`, { t: tokenOf(confirm.data.manageUrl), reason: "ill" }, { EMAIL: email.binding });
    expect(r.status).toBe(200);
    const [b] = await rows("SELECT status, sequence, cancelled_by, cancel_reason FROM bookings");
    expect(b).toEqual({ status: "cancelled", sequence: 1, cancelled_by: "visitor", cancel_reason: "ill" });
    expect(await rows("SELECT COUNT(*) AS n FROM slot_cells")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT n FROM day_counts ORDER BY type_id")).toEqual([{ n: 0 }, { n: 0 }]);
    const d = await rows("SELECT kind, sequence, status, last_error FROM deliveries ORDER BY kind");
    expect(d).toEqual([
      { kind: "owner_cancel", sequence: 1, status: "sent", last_error: null },
      { kind: "owner_new", sequence: 0, status: "sent", last_error: null },
      { kind: "reminder_owner_1440", sequence: 0, status: "skipped", last_error: "cancelled" },
      { kind: "reminder_owner_60", sequence: 0, status: "skipped", last_error: "cancelled" },
    ]);
    expect(email.sent).toHaveLength(2);
    // Cancelling twice changes nothing.
    expect((await postJson(`/b/${confirm.data.bookingId}/cancel`, { t: tokenOf(confirm.data.manageUrl) })).status).toBe(409);
  });

  it("reschedule moves atomically: new cells claimed, old released, SEQUENCE + 1, same UID; a clash changes nothing", async () => {
    mockFetch();
    const a = await book(TUE_0900);
    const other = await book("2026-03-04T10:00:00.000Z", { details: { ...visitor, email: "bob@example.org" }, ip: "198.51.100.5" });
    expect(other.confirm.status).toBe(200);
    const t = tokenOf(a.confirm.data.manageUrl);
    const id = a.confirm.data.bookingId;
    // The page lists times, and moving by 15 minutes (overlapping itself) is offered.
    const page = await (await call(`/b/${id}/reschedule?t=${t}`)).text();
    expect(page).toContain(`value="${Date.parse("2026-03-03T09:15:00Z")}"`);
    // Clash with Bob's booking: 409, nothing changed.
    const clash = await postJson(`/b/${id}/reschedule`, { t, start: Date.parse("2026-03-04T10:15:00Z") });
    expect(clash.status).toBe(409);
    expect((await rows("SELECT start_ms, sequence FROM bookings WHERE id = ?1", id))[0]).toEqual({ start_ms: Date.parse(TUE_0900), sequence: 0 });
    expect(await rows("SELECT COUNT(*) AS n FROM slot_cells WHERE booking_id = ?1", id)).toEqual([{ n: 3 }]);
    // A real move (overlapping its own old cells).
    const moved = await postJson(`/b/${id}/reschedule`, { t, start: Date.parse("2026-03-03T09:15:00Z") });
    expect(moved.status).toBe(200);
    const [b] = await rows("SELECT start_ms, sequence FROM bookings WHERE id = ?1", id);
    expect(b).toEqual({ start_ms: Date.parse("2026-03-03T09:15:00Z"), sequence: 1 });
    expect((await rows("SELECT cell_ms FROM slot_cells WHERE booking_id = ?1 ORDER BY cell_ms", id)).map((r) => r.cell_ms)).toEqual([15, 30, 45].map((m) => Date.parse(TUE_0900) + m * MIN));
    expect((await rows("SELECT kind, sequence, status FROM deliveries WHERE booking_id = ?1 AND kind LIKE 'reminder%' ORDER BY sequence, kind", id))).toEqual([
      { kind: "reminder_owner_1440", sequence: 0, status: "skipped" },
      { kind: "reminder_owner_60", sequence: 0, status: "skipped" },
      { kind: "reminder_owner_1440", sequence: 1, status: "pending" },
      { kind: "reminder_owner_60", sequence: 1, status: "pending" },
    ]);
    const ics = await (await call(`/b/${id}/invite.ics?t=${tokenOf(moved.data.manageUrl)}`)).text();
    expect(ics).toContain(`UID:${id}@booking.test`);
    expect(ics).toContain("SEQUENCE:1");
    expect(ics).toContain("DTSTART:20260303T091500Z");
  });

  it("a reschedule to another day moves the day counts", async () => {
    mockFetch();
    const a = await book(TUE_0900);
    const r = await postJson(`/b/${a.confirm.data.bookingId}/reschedule`, { t: tokenOf(a.confirm.data.manageUrl), start: Date.parse("2026-03-05T09:00:00Z") });
    expect(r.status).toBe(200);
    expect(await rows("SELECT local_day, type_id, n FROM day_counts ORDER BY local_day, type_id")).toEqual([
      { local_day: "2026-03-03", type_id: "*", n: 0 },
      { local_day: "2026-03-03", type_id: "30min", n: 0 },
      { local_day: "2026-03-05", type_id: "*", n: 1 },
      { local_day: "2026-03-05", type_id: "30min", n: 1 },
    ]);
  });

  it("no cancelling after the meeting has started", async () => {
    mockFetch();
    const a = await book(TUE_0900);
    setNow(Date.parse(TUE_0900) + MIN);
    const r = await postJson(`/b/${a.confirm.data.bookingId}/cancel`, { t: tokenOf(a.confirm.data.manageUrl) });
    expect(r.status).toBe(409);
  });
});

describe("owner approval", () => {
  beforeEach(resetAll);

  async function request() {
    const { confirm } = await book("2026-03-05T09:00:00Z", { type: "60min", details: { ...visitor, location: "in-person" } });
    const app = appFor();
    const b = (await rows("SELECT * FROM bookings WHERE id = ?1", confirm.data.bookingId))[0];
    return { id: b.id, url: await approveUrl(app, b) };
  }

  it("the approve page is a button (GET changes nothing); approving confirms and sends the invite once", async () => {
    mockFetch();
    const email = fakeEmail();
    const { id, url } = await request();
    const page = await call(path(url));
    expect(await page.text()).toContain("<button type=\"submit\">Approve</button>");
    expect((await rows("SELECT status FROM bookings"))[0].status).toBe("requested");
    const r = await postForm(`/r/${id}/approve`, { t: tokenOf(url), link: "https://meet.example.com/special" }, { EMAIL: email.binding });
    expect(r.status).toBe(200);
    expect((await rows("SELECT status, location_detail FROM bookings"))[0]).toEqual({ status: "confirmed", location_detail: "https://meet.example.com/special" });
    expect((await rows("SELECT kind, status FROM deliveries ORDER BY kind")).map((d) => `${d.kind}:${d.status}`)).toEqual([
      "owner_new:sent", "owner_request:sent", "reminder_owner_1440:pending", "reminder_owner_60:pending",
    ]);
    // Approving again does nothing.
    expect((await postForm(`/r/${id}/approve`, { t: tokenOf(url) }, { EMAIL: email.binding })).status).toBe(409);
  });

  it("declining frees the time", async () => {
    mockFetch();
    const { id, url } = await request();
    const r = await postForm(`/r/${id}/decline`, { t: tokenOf(url), reason: "Booked up" });
    expect(r.status).toBe(200);
    expect((await rows("SELECT status, cancelled_by FROM bookings"))[0]).toEqual({ status: "declined", cancelled_by: "owner" });
    expect(await rows("SELECT COUNT(*) AS n FROM slot_cells")).toEqual([{ n: 0 }]);
  });

  it("a request not approved in time expires: cells released, you're told", async () => {
    mockFetch();
    const email = fakeEmail();
    const { id, url } = await request();
    setNow(NOW + 48 * HOUR + MIN);
    const app = appFor({ EMAIL: email.binding });
    await runHousekeeping(app, { now: NOW + 48 * HOUR + MIN, force: true });
    expect((await rows("SELECT status, sequence FROM bookings"))[0]).toEqual({ status: "expired", sequence: 1 });
    expect(await rows("SELECT COUNT(*) AS n FROM slot_cells")).toEqual([{ n: 0 }]);
    expect((await rows("SELECT kind, status, last_error FROM deliveries WHERE kind IN ('owner_expired', 'visitor_cancel') ORDER BY kind"))).toEqual([
      { kind: "owner_expired", status: "sent", last_error: null },
      { kind: "visitor_cancel", status: "skipped", last_error: 'visitorEmail is "none"' },
    ]);
    // The approve link still opens, but approving is refused.
    expect((await postForm(`/r/${id}/approve`, { t: tokenOf(url) })).status).toBe(404); // link expired with the request
  });
});

describe("emails to visitors (an email service connected)", () => {
  beforeEach(resetAll);

  it("provider: confirmation with REQUEST .ics, reminders, cancellation with CANCEL, once each", async () => {
    const calls = mockFetch();
    const email = fakeEmail();
    const envs = { ...RESEND, EMAIL: email.binding };
    const { confirm } = await book(TUE_0900, { envOverrides: envs, which: "provider" });
    expect(confirm.status).toBe(200);
    const resend = () => calls.filter((c) => c.url.startsWith("https://api.resend.com/")).map((c) => JSON.parse(c.body));
    expect(resend()).toHaveLength(1);
    const first = resend()[0];
    expect(first.to).toEqual(["ada@example.org"]);
    expect(first.subject).toMatch(/^Booked: Call with Sam Example, Tuesday,? 3 March 2026.*04:00/);
    expect(first.attachments[0]).toMatchObject({ filename: "invite.ics", content_type: "text/calendar; method=REQUEST; charset=utf-8" });
    expect(atob(first.attachments[0].content)).toContain("METHOD:REQUEST");
    expect(first.html).toContain("Change or cancel");
    // The owner's email went through send_email (free), not Resend.
    expect(email.sent).toHaveLength(1);
    const kinds = (await rows("SELECT kind FROM deliveries ORDER BY kind")).map((d) => d.kind);
    expect(kinds).toEqual(["owner_new", "reminder_owner_1440", "reminder_owner_60", "reminder_visitor_1440", "reminder_visitor_60", "visitor_confirm"]);
    // Cancel: visitor gets a CANCEL.
    const r = await postJson(`/b/${confirm.data.bookingId}/cancel`, { t: tokenOf(confirm.data.manageUrl) }, envs, "provider");
    expect(r.status).toBe(200);
    const last = resend().at(-1);
    expect(last.subject).toMatch(/^Cancelled:/);
    expect(atob(last.attachments[0].content)).toContain("METHOD:CANCEL");
    expect(resend()).toHaveLength(2);
  });

  it("at most 2 confirmation emails per address per day; unknown outcomes are never retried", async () => {
    mockFetch();
    const envs = { ...RESEND, EMAIL: fakeEmail().binding };
    for (const [i, s] of ["2026-03-03T09:00:00Z", "2026-03-04T09:00:00Z", "2026-03-05T09:00:00Z"].entries()) {
      await book(s, { envOverrides: envs, which: "provider", ip: `198.51.100.${30 + i}` });
    }
    const v = await rows("SELECT status, last_error FROM deliveries WHERE kind = 'visitor_confirm' ORDER BY created_ms");
    expect(v.map((x) => x.status)).toEqual(["sent", "sent", "skipped"]);
    expect(v[2].last_error).toMatch(/already sent 2 to this address today/);
    mockFetch({ resendStatus: 500 });
    await book("2026-03-06T09:00:00Z", { envOverrides: envs, which: "provider", details: { ...visitor, email: "new@example.org" }, ip: "198.51.100.40" });
    const last = await rows("SELECT d.status FROM deliveries d JOIN bookings b ON b.id = d.booking_id WHERE b.email = 'new@example.org' AND d.kind = 'visitor_confirm'");
    expect(last[0].status).toBe("unknown");
  });

  it("no-JS bookings never email the visitor (no Turnstile on that path)", async () => {
    const calls = mockFetch();
    await postForm("/nojs/30min", { start: String(Date.parse(TUE_0900)), name: "A", email: "a@example.org", location: "video" }, { ...RESEND, EMAIL: fakeEmail().binding }, "provider");
    expect(calls.filter((c) => c.url.startsWith("https://api.resend.com/"))).toHaveLength(0);
    expect((await rows("SELECT kind FROM deliveries")).map((d) => d.kind).sort()).toEqual(["owner_new", "reminder_owner_1440", "reminder_owner_60"]);
  });

  it("provider-confirm: the booking stays a hold (30 minutes) until the visitor clicks; the click page is a button", async () => {
    const calls = mockFetch();
    const envs = { ...RESEND, EMAIL: fakeEmail().binding };
    const { confirm } = await book(TUE_0900, { envOverrides: envs, which: "confirm" });
    expect(confirm.data.status).toBe("verify");
    expect(confirm.data.manageUrl).toBeNull();
    const [b] = await rows("SELECT status, verify_pending, hold_expires_at FROM bookings");
    expect(b).toEqual({ status: "held", verify_pending: 1, hold_expires_at: NOW + 30 * MIN });
    const mail = JSON.parse(calls.filter((c) => c.url.startsWith("https://api.resend.com/"))[0].body);
    const link = /https:\/\/booking\.test\/v\/[^"\s]+/.exec(mail.text)[0];
    const page = await call(path(link), {}, envs, "confirm");
    expect(await page.text()).toContain("Confirm my booking");
    expect((await rows("SELECT status FROM bookings"))[0].status).toBe("held");
    const res = await postForm(`/v/${confirm.data.bookingId}`, { t: tokenOf(link) }, envs, "confirm");
    expect(res.status).toBe(303);
    expect((await rows("SELECT status, verify_pending FROM bookings"))[0]).toEqual({ status: "confirmed", verify_pending: 0 });
    expect((await rows("SELECT kind FROM deliveries ORDER BY kind")).map((d) => d.kind)).toContain("visitor_confirm");
  });
});

describe("the bookings feed", () => {
  beforeEach(resetAll);

  it("lists bookings and requests with the invites' UID and SEQUENCE, no METHOD; a wrong secret is a 404", async () => {
    mockFetch();
    const a = await book(TUE_0900);
    await book("2026-03-05T09:00:00Z", { type: "60min", details: { ...visitor, location: "in-person", email: "b@example.org" }, ip: "198.51.100.3" });
    const res = await call("/feed/test-feed-secret-0123456789.ics");
    const text = await res.text();
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(text).not.toContain("METHOD:");
    expect(text).toContain(`UID:${a.confirm.data.bookingId}@booking.test`);
    expect(text).toContain("STATUS:CONFIRMED");
    expect(text).toContain("STATUS:TENTATIVE");
    expect(text).toContain("ada@example.org");
    expect((await call("/feed/wrong-secret-0123456789.ics")).status).toBe(404);
    expect((await call("/feed/test-feed-secret-0123456789.ics", {}, { FEED_SECRET: "a-new-secret-0123456789" })).status).toBe(404);
  });
});
