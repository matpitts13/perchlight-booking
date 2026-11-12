#!/usr/bin/env node
// Checks booking.json the same way the Worker does (no dependencies).
//   npm run check            (or: node cli/check-config.mjs path/to/booking.json)
import { readFile } from "node:fs/promises";
import { checkConfig } from "../src/lib/config.js";

const file = process.argv[2] ?? new URL("../booking.json", import.meta.url);
const raw = JSON.parse(await readFile(file, "utf8"));
const c = checkConfig(raw);
for (const t of c.types.values()) console.log(`${t.on ? "on " : "OFF"}  /${t.id}  ${t.name} (${t.minutes} min${t.approval ? ", needs approval" : ""})`);
if (c.errors.length) {
  console.error(`\n${c.errors.length} problem(s):`);
  for (const e of c.errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`\nbooking.json is fine. Owner: ${c.owner.name}, ${c.owner.timeZone}. Visitor email: ${c.visitorEmail}.`);