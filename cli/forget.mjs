#!/usr/bin/env node
// Erases everything for one email address (a GDPR erasure request), calling
// DELETE /api/bookings?email= until nothing is left. No dependencies.
//   ADMIN_TOKEN=... npm run forget -- https://book.example.com someone@example.com
// Upcoming bookings for that address are cancelled first (their time is freed)
// and you're emailed the list. Export first if they asked for a copy: npm run export.
const [base, email] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
if (!base || !email || !token) {
  console.error("Usage: ADMIN_TOKEN=... npm run forget -- https://<your worker> someone@example.com");
  process.exit(1);
}
const url = `${base.replace(/\/+$/, "")}/api/bookings?email=${encodeURIComponent(email)}`;
let erased = 0;
const cancelled = [];
for (let call = 0; call < 1000; call++) {
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    console.error(`HTTP ${res.status}: ${data?.error ?? "unexpected answer"} (erased ${erased} so far)`);
    process.exit(1);
  }
  erased += data.erased;
  cancelled.push(...data.cancelledUpcoming);
  if (!data.more) break;
}
console.log(`Erased ${erased} booking(s) for that address.`);
for (const c of cancelled) console.log(`  cancelled upcoming: ${c.type} at ${c.start}`);