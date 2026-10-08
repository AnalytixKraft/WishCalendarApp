/* The bridge's HTTP API: node:http, JSON in and out, no framework.
 *
 * The one caller is the app (app/src/bridge.mjs), over the `whatsapp` compose
 * network. No other container can reach it — the service publishes no port
 * and is not in the tunnel — but the Docker host itself may be able to (Linux
 * routes to a user-defined bridge network, so any local process can open
 * <container-ip>:3000). That is why every route but /healthz needs the token.
 * The contract, with every error code, is in whatsapp/README.md; keep the two
 * in step.
 *
 *   GET  /healthz   no auth, no state: 200 while the process is alive
 *   GET  /status    session state (and the QR while pairing)
 *   POST /pair      start pairing, if idle
 *   POST /logout    unlink and wipe the session
 *   GET  /groups    the groups the linked number is in
 *   POST /send      post text into ONE chat: a group, or a phone number
 *   GET  /commands        the 📅 messages the owner sent, held for the app,
 *                         and the chats they count in
 *   POST /commands/ack    the app has these: let them go
 *   POST /commands/chats  the chats 📅 messages count in: "self", groups
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { BridgeError, log } from "./util.mjs";

/* Where /send may post: a group, or a person by phone number (country code
 * first, 8 to 15 digits, as E.164 allows). A LID, a broadcast list, a
 * channel or a status can never match. Direct messages carry more ban risk
 * than group posts, so session.mjs checks the number is on WhatsApp and caps
 * how many go out an hour. */
const GROUP_JID = /^\d+(-\d+)?@g\.us$/;
const DIRECT_JID = /^[1-9]\d{7,14}@s\.whatsapp\.net$/;
/* In characters as a person counts them — code points — not JavaScript's
 * .length, which counts UTF-16 units and so counts every emoji twice. A
 * birthday wish is mostly emoji by weight; counted in units, a message well
 * under the limit could come back invalid_text. */
const MAX_TEXT = 20_000;
const MAX_KEY = 200;

/* Bodies are read into memory whole, so they are capped, and only /send and
 * the two /commands posts read one at all. 256 KB holds the text worst case — 20 000 astral characters,
 * each \u-escaped as a surrogate pair, is 240 000 bytes — with room for the
 * other fields. A large body is memory held for the asking. */
const MAX_BODY_BYTES = 256 * 1024;

const ROUTES = {
  "/status": "GET",
  "/pair": "POST",
  "/logout": "POST",
  "/groups": "GET",
  "/send": "POST",
  "/commands": "GET",
  "/commands/ack": "POST",
  "/commands/chats": "POST",
};

/* What /commands/ack takes: the ids /commands gave, at most a few hundred. */
const MAX_ACK = 500;

/* What /commands/chats takes: "self" (Message yourself) and group ids. */
function parseChats(body) {
  const { chats } = body;
  if (!Array.isArray(chats) || chats.length > MAX_ACK || !chats.every((c) => c === "self" || (typeof c === "string" && GROUP_JID.test(c)))) {
    throw new BridgeError(400, "invalid_chats");
  }
  return chats;
}

function parseAck(body) {
  const { ids } = body;
  if (!Array.isArray(ids) || ids.length > MAX_ACK || !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_KEY)) {
    throw new BridgeError(400, "invalid_ids");
  }
  return ids;
}

/* Compare digests, not the strings: equal-length buffers, so timingSafeEqual
 * never throws on a wrong-length guess and the comparison leaks neither the
 * token's content nor its length through timing. */
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest();

function reply(res, status, body) {
  // no-store: /status can carry a live QR, and nothing here is worth caching.
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new BridgeError(413, "payload_too_large", `the body must be under ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError(400, "invalid_json", "the body must be a JSON object");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BridgeError(400, "invalid_json", "the body must be a JSON object");
  }
  return body;
}

/* Node's HTTP parser lets through request-targets that URL rejects
 * (`GET http://[ HTTP/1.1`). That is a malformed request like any other: a
 * 400, not an exception thrown outside the handler's try, which would leave
 * the connection hanging with no answer at all. */
function pathOf(req) {
  try {
    return new URL(req.url || "/", "http://bridge").pathname;
  } catch {
    throw new BridgeError(400, "bad_request", "the request target is not a valid URL");
  }
}

/* Whether `s` is at most `max` code points (MAX_TEXT says why code points).
 * Without spreading it into an array: a code point is one or two UTF-16
 * units, so over 2 × max units is over max code points whatever the string
 * holds, and only a string short enough to be in doubt is walked. */
function withinCodePoints(s, max) {
  if (s.length <= max) return true;
  if (s.length > 2 * max) return false;
  let n = 0;
  for (const _ of s) if (++n > max) return false;
  return true;
}

/* Validation happens here, before the session is asked anything, so a bad
 * request gets its 400 whatever state WhatsApp is in. */
function parseSend(body) {
  const { chat_id: chatId, text, idempotency_key: key } = body;
  if (typeof chatId !== "string" || !(GROUP_JID.test(chatId) || DIRECT_JID.test(chatId))) {
    throw new BridgeError(400, "invalid_chat_id");
  }
  if (typeof text !== "string" || text.trim() === "" || !withinCodePoints(text, MAX_TEXT)) {
    throw new BridgeError(400, "invalid_text");
  }
  if (typeof key !== "string" || key.trim() === "" || key.length > MAX_KEY) {
    throw new BridgeError(400, "missing_idempotency_key");
  }
  return { chatId, key, text };
}

/* `session` is null when no usable token was configured: then every route
 * but /healthz answers 503 and WhatsApp is never touched (see main.mjs). */
export function createApi({ token, session }) {
  const expected = session ? sha256(token) : null;

  function authorized(req) {
    // The scheme is case-insensitive and followed by one or more spaces
    // (RFC 9110 §11.1, §11.4): "bearer <token>" is the same credential, and
    // refusing it would be a 401 no one could explain. The token itself is
    // compared exactly.
    const match = /^Bearer +(.+)$/i.exec(req.headers.authorization || "");
    return Boolean(match) && timingSafeEqual(sha256(match[1]), expected);
  }

  async function route(req, res, path) {
    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") throw new BridgeError(405, "method_not_allowed");
      return reply(res, 200, { ok: true });
    }
    if (!session) {
      // `state` as well, so a caller reading /status sees the state it expects.
      throw new BridgeError(503, "bridge_token_not_configured", null, { state: "unconfigured" });
    }
    // Auth before the route lookup, so a caller without the token learns
    // nothing about which paths exist.
    if (!authorized(req)) throw new BridgeError(401, "unauthorized");
    const method = ROUTES[path];
    if (!method) throw new BridgeError(404, "not_found");
    if (req.method !== method) {
      res.setHeader("allow", method);
      throw new BridgeError(405, "method_not_allowed");
    }
    switch (path) {
      case "/status":
        return reply(res, 200, session.status());
      case "/pair":
        return reply(res, 200, await session.pair());
      case "/logout":
        return reply(res, 200, await session.logout());
      case "/groups":
        return reply(res, 200, { groups: await session.groups() });
      case "/send":
        return reply(res, 200, await session.send(parseSend(await readJson(req))));
      case "/commands":
        return reply(res, 200, { commands: session.commands(), chats: session.commandChats() });
      case "/commands/chats":
        return reply(res, 200, { chats: session.setCommandChats(parseChats(await readJson(req))) });
      case "/commands/ack":
        return reply(res, 200, { acked: session.ackCommands(parseAck(await readJson(req))) });
    }
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    let path = null; // stays null, and is logged so, when the target will not parse
    try {
      path = pathOf(req);
      await route(req, res, path);
    } catch (err) {
      if (res.headersSent) {
        res.end();
      } else if (err instanceof BridgeError) {
        // A 413 leaves the rest of the body unread; close rather than reuse.
        if (err.status === 413) res.setHeader("connection", "close");
        reply(res, err.status, err.body());
      } else {
        log.error({ path, err: err?.stack || String(err) }, "unexpected error");
        reply(res, 500, { error: "internal_error" });
      }
    }
    // Every change and every refusal; not the healthcheck, and not the app's
    // /status polling while a QR is on screen. Method, path, status and time
    // only — never headers (the token) or bodies (the text).
    if (path !== "/healthz" && (req.method !== "GET" || res.statusCode >= 400)) {
      log.info({ method: req.method, path, status: res.statusCode, ms: Date.now() - started }, "request");
    }
  });
  // How long a client may take to DELIVER its request — the headers, then
  // the whole request with its body — before Node answers 408 and closes.
  // Neither bounds how long we take to answer: /send bounds itself
  // (SEND_TIMEOUT_MS in session.mjs) and the app bounds its wait (a read
  // timeout above that). Short, because the only legitimate client is one
  // container away: a request still arriving after seconds is stalled, not
  // slow.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}
