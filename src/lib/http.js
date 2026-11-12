// Small HTTP helpers. Copied from perchlight-forms src/lib/http.js, plus
// readBody (JSON or a plain form post) and html().

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

/** An API error: { ok: false, error }. */
export function fail(status, error, extra = {}) {
  return json({ ok: false, error, ...extra }, status);
}

export function redirect(url, status = 303, extraHeaders = {}) {
  return new Response(null, { status, headers: { Location: url, "Cache-Control": "no-store", ...extraHeaders } });
}

export function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders } });
}

export function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'",
      ...extraHeaders,
    },
  });
}

/** @param {unknown} s */
export function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Reads a JSON object or a urlencoded / multipart form of at most maxBytes, or null. */
export async function readBody(request, maxBytes = 32 * 1024) {
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (len > maxBytes) return null;
  const type = (request.headers.get("Content-Type") ?? "").toLowerCase();
  const t = await request.text();
  if (t.length > maxBytes) return null;
  if (type.startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(t));
  }
  if (type.startsWith("multipart/form-data")) {
    try {
      const fd = await new Response(t, { headers: { "Content-Type": request.headers.get("Content-Type") } }).formData();
      const out = {};
      for (const [k, v] of fd) if (typeof v === "string") out[k] = v;
      return out;
    } catch {
      return null;
    }
  }
  try {
    const v = JSON.parse(t || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** True when a request came from a plain HTML form (it wants a page back). */
export function isFormPost(request) {
  const type = (request.headers.get("Content-Type") ?? "").toLowerCase();
  return type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data");
}

/** "YYYY-MM-DD HH:MM:SS" (UTC), the format D1's datetime('now') uses. */
export function sqlTime(ms = Date.now()) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function utcDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}
