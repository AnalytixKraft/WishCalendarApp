/* Signing in: one password (ADMIN_PASSWORD in .env), and a signed cookie that
 * lasts 30 days. Nothing is stored server-side: the cookie carries its expiry
 * and an HMAC over it. The HMAC key is derived from SESSION_SECRET and the
 * password together, so changing either signs everyone out.
 *
 * The page may be public (a Cloudflare tunnel), so failed sign-ins are
 * throttled per address: 5 in 15 minutes, then that address waits. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "bdr_session";
export const MAX_AGE_S = 30 * 24 * 60 * 60;

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest();

export function createAuth({ password, secret }) {
  const expected = sha256(password);
  const key = createHmac("sha256", secret).update("session\0").update(expected).digest();
  const sign = (payload) => createHmac("sha256", key).update(payload).digest("base64url");

  return {
    /* Digests, so the comparison is constant-time whatever the lengths. */
    checkPassword: (candidate) => timingSafeEqual(sha256(String(candidate ?? "")), expected),

    issue() {
      const payload = `v1.${Math.floor(Date.now() / 1000) + MAX_AGE_S}.${randomBytes(9).toString("base64url")}`;
      return `${payload}.${sign(payload)}`;
    },

    verify(value) {
      const parts = String(value ?? "").split(".");
      if (parts.length !== 4 || parts[0] !== "v1") return false;
      const payload = parts.slice(0, 3).join(".");
      const given = Buffer.from(parts[3]);
      const wanted = Buffer.from(sign(payload));
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return false;
      return Number(parts[1]) > Date.now() / 1000;
    },
  };
}

export function createThrottle({ limit = 5, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
  const failures = new Map(); // address → timestamps of recent failures

  function recent(address) {
    const cutoff = now() - windowMs;
    const list = (failures.get(address) || []).filter((t) => t > cutoff);
    if (list.length) failures.set(address, list);
    else failures.delete(address);
    return list;
  }

  return {
    /* Minutes this address must wait, or 0. */
    waitMinutes(address) {
      const list = recent(address);
      if (list.length < limit) return 0;
      return Math.max(1, Math.ceil((list[0] + windowMs - now()) / 60_000));
    },
    fail(address) {
      failures.set(address, [...recent(address), now()]);
      // Bounded: a flood from many addresses cannot grow this without limit.
      if (failures.size > 10_000) failures.delete(failures.keys().next().value);
    },
    reset(address) {
      failures.delete(address);
    },
  };
}
