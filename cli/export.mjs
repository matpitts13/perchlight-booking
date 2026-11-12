#!/usr/bin/env node
// Exports every booking for one email address (a subject access request).
//   ADMIN_TOKEN=... npm run export -- https://book.example.com someone@example.com [csv|json] > out.csv
const [base, email, format = "csv"] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
if (!base || !email || !token) {
  console.error("Usage: ADMIN_TOKEN=... npm run export -- https://<your worker> someone@example.com [csv|json]");
  process.exit(1);
}
const res = await fetch(`${base.replace(/\/+$/, "")}/api/export?email=${encodeURIComponent(email)}&format=${format}`, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
process.stdout.write(Buffer.from(await res.arrayBuffer()));