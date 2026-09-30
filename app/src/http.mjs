/* Small HTTP helpers for node:http: forms, cookies, redirects, and the
 * headers every answer carries. */

import { BridgeError } from "./bridge.mjs";

/* No inline script or style anywhere, and nothing loaded from elsewhere:
 * the page works offline, and an injected <script> has nowhere to run. */
export const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "cache-control": "no-store", ...headers });
  res.end(body);
}

export const sendHtml = (res, status, html, headers = {}) =>
  send(res, status, String(html), { "content-type": "text/html; charset=utf-8", ...headers });

export const sendJson = (res, status, data) =>
  send(res, status, JSON.stringify(data), { "content-type": "application/json; charset=utf-8" });

export function redirect(res, location, headers = {}) {
  send(res, 303, "", { location, ...headers });
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in cookies)) {
      try {
        cookies[name] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // A malformed cookie is no cookie.
      }
    }
  }
  return cookies;
}

export function serializeCookie(name, value, { maxAge, secure = false } = {}) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(maxAge !== undefined ? [`Max-Age=${maxAge}`] : []),
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/* Through the Cloudflare tunnel the browser speaks https to Cloudflare, and
 * cloudflared says so; on localhost it is plain http. */
export const isHttps = (req) => req.headers["x-forwarded-proto"] === "https";

export function clientAddress(req) {
  return String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown");
}

/* A form post, as {get(name), all(name)}. */
export async function readForm(req, maxBytes = 1_000_000) {
  const type = req.headers["content-type"] || "";
  if (!type.startsWith("application/x-www-form-urlencoded")) {
    throw new HttpError(415, "Send the form as application/x-www-form-urlencoded.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "That form is too large.");
    chunks.push(chunk);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  return {
    get: (name) => (params.get(name) ?? "").trim(),
    raw: (name) => params.get(name) ?? "",
    all: (name) => params.getAll(name),
    has: (name) => params.has(name),
  };
}

/* A post from a page this app served, not from another site riding the
 * cookie. SameSite=Lax already keeps the cookie off cross-site posts; this
 * is the second lock. Browsers send Sec-Fetch-Site; Origin is the fallback. */
export function isSameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.origin;
  if (!origin || origin === "null") return !origin;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export const describeError = (err) => (err instanceof BridgeError || err instanceof HttpError ? err.message : String(err?.message || err));
