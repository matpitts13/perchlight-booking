// Rate limits without storing IPs. networkOf / rateKey copied from
// perchlight-forms src/lib/spam.js; the in-memory block list from
// src/lib/counters.js.
import { hmacHex, sha256Hex } from "./crypto.js";
import { utcDay } from "./http.js";

/** IPv4 address, or the IPv6 /64 (each IPv6 user gets a whole /64). */
export function networkOf(ip) {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":");
}

/**
 * SHA-256 of HMAC(IP_SALT, UTC date) : action : network. The day is in the
 * key, so one visitor's hashes can't be linked across days, and with IP_SALT
 * secret they can't be reversed by trying every IPv4 address.
 */
export async function rateKey(salt, day, action, ip) {
  const dayKey = await hmacHex(salt, day);
  return sha256Hex(`${dayKey}:${action}:${networkOf(ip)}`);
}

// Networks already over their hourly limit, refused from memory without a
// D1 write. Cleared when the hour changes.
const blocked = new Set();
let blockedHour = "";

function roll(hour) {
  if (hour !== blockedHour) {
    blocked.clear();
    blockedHour = hour;
  }
}

/** Tests only. */
export function resetBlocked() {
  blocked.clear();
  blockedHour = "";
}

/**
 * Counts one attempt of `action` from this network this hour.
 * @returns {Promise<{ ok: boolean, key: string }>} key: the day's hash (also used for "holds at once")
 */
export async function hit(env, action, ip, perHour, now = Date.now()) {
  const key = await rateKey(env.IP_SALT, utcDay(now), action, ip);
  if (perHour <= 0) return { ok: true, key };
  const hour = new Date(now).toISOString().slice(0, 13);
  roll(hour);
  if (blocked.has(key)) return { ok: false, key };
  const row = await env.DB.prepare(
    `INSERT INTO rate_counters (key, hour, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key, hour) DO UPDATE SET count = count + 1 RETURNING count`,
  ).bind(key, hour).first();
  if (row && row.count > perHour) {
    if (blocked.size > 10000) blocked.clear();
    blocked.add(key);
    return { ok: false, key };
  }
  return { ok: true, key };
}

/** The network's hash for today without counting anything. */
export function netKey(env, ip, now = Date.now()) {
  return rateKey(env.IP_SALT, utcDay(now), "net", ip);
}
