/* The small pieces both halves of the bridge share: the logger, the error the
 * API turns into a JSON answer, a map whose entries expire, and a timeout.
 *
 * Deliberately free of Baileys. main.mjs imports this module even when no
 * token is configured, and in that state the WhatsApp library is never loaded
 * at all (see main.mjs).
 */

import pino from "pino";

/* One JSON object per line on stdout. Docker's json-file driver is the log
 * store, capped by the `logging` anchor in docker-compose.yml.
 *
 * THREE THINGS NEVER GO IN HERE: the bearer token, a QR string, and what a
 * message says. Nothing redacts them for you — every call site passes only
 * states, error codes, group ids and message ids, and it has to stay that way.
 * A QR in a log is a working "link a device to this account" for anyone who
 * can run `docker logs` while it is valid, and the token opens /send. */
export const log = pino({
  // No pid/hostname on every line: one process per container, and the
  // hostname is the container id `docker logs` already knows.
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  // "level":"warn" rather than "level":40, so a human can grep it.
  formatters: { level: (label) => ({ level: label }) },
});

/* Baileys takes a pino-compatible logger, and it is chatty. At `info` it logs
 * the linked phone number on every pairing and a stack trace on every
 * reconnect; at `debug`/`trace` it logs protocol traffic in bulk. `warn`
 * keeps what an operator needs to see and nothing more. */
export const baileysLog = log.child({ mod: "baileys" }, { level: "warn" });

/* An error the API answers with as-is: an HTTP status and a stable machine
 * code, `{"error": code}`. A `message` goes in only where the caller has
 * nothing better — WhatsApp's own reason on send_failed, and codes the app
 * has no wording for. The app writes its own sentence for every code it
 * knows and appends our `message`, so one on those would say the same thing
 * twice. */
export class BridgeError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  body() {
    return { error: this.code, ...(this.message !== this.code ? { message: this.message } : {}), ...this.extra };
  }
}

/* A Map whose entries expire. Two uses, both tiny: group metadata for Baileys'
 * cachedGroupMetadata (minutes) and /send idempotency keys (a day). Expired
 * entries are dropped on read and swept on every write, so it can never hold
 * more than one TTL's worth of writes — a handful. */
export class TtlCache {
  #ttlMs;
  #map = new Map();

  constructor(ttlMs) {
    this.#ttlMs = ttlMs;
  }

  get(key) {
    const hit = this.#map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.#map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value) {
    const now = Date.now();
    for (const [k, hit] of this.#map) if (hit.expiresAt <= now) this.#map.delete(k);
    this.#map.set(key, { value, expiresAt: now + this.#ttlMs });
  }

  delete(key) {
    this.#map.delete(key);
  }

  clear() {
    this.#map.clear();
  }
}

/* Rejects with onTimeout() if `promise` has not settled within `ms`. It does
 * NOT cancel the underlying work — callers that care (a send that may still
 * land) keep their own handle on it. */
export function withTimeout(promise, ms, onTimeout = () => new Error(`timed out after ${ms} ms`)) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
