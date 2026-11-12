#!/usr/bin/env node
// Measures how much CPU parsing a calendar feed takes, in Node's V8 (the
// engine Workers use), on generated feeds shaped like a personal Google
// export: mostly past one-off events with descriptions and attendees, some
// future ones, and weekly series with exceptions. This is NOT a Cloudflare
// measurement: Workers' CPU differs from this machine's. Measure there too
// (dashboard > Workers > your Worker > Metrics > CPU time).
//   npm run measure                 (2,000 events, plus 100 KB to 2 MB feeds)
//   node cli/measure-ics.mjs 5000   (one size)
import { parseIcs } from "../src/lib/ics-parse.js";

const NOW = Date.UTC(2026, 10, 11);
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, "0");
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const local = (ms) => stamp(ms).replace("Z", "");

/** A feed with n events; returns the ICS text. */
export function feed(n) {
  const out = ["BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-TIMEZONE:Europe/London"];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < n; i++) {
    const kind = rnd();
    const desc = `Notes for meeting ${i}: ${"agenda item, discussion, follow-up. ".repeat(1 + Math.floor(rnd() * 6))}`;
    const ev = ["BEGIN:VEVENT"];
    if (kind < 0.08) {
      // weekly series started in the past, some with exceptions
      const start = NOW - Math.floor(rnd() * 900) * DAY + 9 * 3600_000;
      ev.push(`DTSTART;TZID=Europe/London:${local(start)}`, `DTEND;TZID=Europe/London:${local(start + 3600_000)}`, `RRULE:FREQ=WEEKLY;BYDAY=${["MO", "TU", "WE", "TH", "FR"][i % 5]}`);
      if (rnd() < 0.5) ev.push(`EXDATE;TZID=Europe/London:${local(start + 7 * DAY * (1 + Math.floor(rnd() * 40)))}`);
    } else if (kind < 0.1) {
      const start = NOW - Math.floor(rnd() * 400) * DAY + 14 * 3600_000;
      ev.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(start + 1800_000)}`, `RRULE:FREQ=MONTHLY;BYDAY=${1 + (i % 4)}TU`);
    } else if (kind < 0.25) {
      const start = NOW + Math.floor(rnd() * 70) * DAY + (8 + Math.floor(rnd() * 9)) * 3600_000;
      ev.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(start + 3600_000)}`);
    } else if (kind < 0.3) {
      const d = new Date(NOW - Math.floor(rnd() * 3000) * DAY);
      const ds = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
      ev.push(`DTSTART;VALUE=DATE:${ds}`, `DTEND;VALUE=DATE:${ds}`, "TRANSP:TRANSPARENT");
    } else {
      const start = NOW - Math.floor(rnd() * 3650) * DAY + (8 + Math.floor(rnd() * 9)) * 3600_000;
      ev.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(start + 3600_000)}`);
    }
    ev.push(`DTSTAMP:${stamp(NOW)}`, `UID:${i.toString(36)}${Math.floor(rnd() * 1e9).toString(36)}@google.com`, `CREATED:${stamp(NOW - 4000 * DAY)}`);
    // Google folds long lines at 75 octets.
    const d = `DESCRIPTION:${desc}`;
    ev.push(d.slice(0, 75), ...(d.slice(75).match(/.{1,74}/g) ?? []).map((x) => ` ${x}`));
    ev.push("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Someone Example;X-NUM-", " GUESTS=0:mailto:someone@example.com", `LAST-MODIFIED:${stamp(NOW)}`, "LOCATION:", "SEQUENCE:0", "STATUS:CONFIRMED", `SUMMARY:Meeting ${i}`, "TRANSP:OPAQUE", "END:VEVENT");
    out.push(...ev);
  }
  out.push("END:VCALENDAR", "");
  return out.join("\r\n");
}

function measure(text, runs = 25) {
  const opts = { ownerZone: "Europe/London", now: NOW, until: NOW + 62 * DAY, uidSuffix: "@book.example.com" };
  for (let i = 0; i < 3; i++) parseIcs(text, opts); // warm up (a fresh isolate is colder: see the first run)
  // Per-run time with performance.now() (the parse is synchronous, with no I/O,
  // so on an idle machine this is CPU time); total CPU over all runs from
  // process.cpuUsage() as a cross-check (its tick is ~15.6 ms on Windows).
  const wall = [];
  let r;
  const c0 = process.cpuUsage();
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    r = parseIcs(text, opts);
    wall.push(performance.now() - t0);
  }
  const c = process.cpuUsage(c0);
  wall.sort((a, b) => a - b);
  return { median: wall[Math.floor(runs / 2)], p95: wall[Math.min(runs - 1, Math.floor(runs * 0.95))], avgCpu: (c.user + c.system) / 1000 / runs, stats: r.stats, busy: r.intervals.length };
}

function cold(text) {
  const t0 = performance.now();
  parseIcs(text, { ownerZone: "Europe/London", now: NOW, until: NOW + 62 * DAY });
  return performance.now() - t0;
}

const arg = process.argv[2];
const sizes = arg ? [Number(arg)] : [2000];
console.log(`Node ${process.version} (V8 ${process.versions.v8}), ${process.platform}/${process.arch}. Times in ms.`);
const first = feed(sizes[0]);
console.log(`cold first parse (fresh process, unoptimised code) of ${sizes[0]} events: ${cold(first).toFixed(1)} ms`);
for (const n of sizes) {
  const text = n === sizes[0] ? first : feed(n);
  const m = measure(text);
  console.log(`${n} events, ${(text.length / 1024).toFixed(0)} KB: median ${m.median.toFixed(1)} ms, p95 ${m.p95.toFixed(1)} ms (average CPU ${m.avgCpu.toFixed(1)} ms); ${m.stats.series} series, ${m.stats.skippedPast} past skipped, ${m.busy} busy intervals`);
}
if (!arg) {
  for (const kb of [100, 500, 1024, 2048]) {
    let n = Math.round(kb * 1.5);
    let text = feed(n);
    n = Math.round((n * kb * 1024) / text.length);
    text = feed(n);
    const m = measure(text, 15);
    console.log(`~${kb} KB feed (${n} events, ${(text.length / 1024).toFixed(0)} KB): median ${m.median.toFixed(1)} ms, p95 ${m.p95.toFixed(1)} ms (average CPU ${m.avgCpu.toFixed(1)} ms)`);
  }
}