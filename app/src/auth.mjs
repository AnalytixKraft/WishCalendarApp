/* Signing in: one password, and a signed cookie that lasts 30 days.
 *
 * The password is the one set on the Settings page — kept as a salted scrypt
 * hash, never the password itself — or, until one is set, ADMIN_PASSWORD
 * from .env. scripts/reset-password.sh removes the one from Settings, so the
 * .env one works again: forgetting it needs the computer, not the page.
 *
 * Nothing is stored per session: the cookie carries its expiry and an HMAC
 * over it. The HMAC key is derived from SESSION_SECRET and the password in
 * force, so changing either signs everyone out.
 *
 * The page may be public (a Cloudflare tunnel), so failed sign-ins are
 * throttled per address: 5 in 15 minutes, then that address waits. */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const COOKIE = "bdr_session";
export const MAX_AGE_S = 30 * 24 * 60 * 60;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

/* About 50–100 ms a try on a laptop: nothing for a person signing in, a lot
 * for anyone guessing. 128·N·r bytes of memory — 32 MB — hence maxmem. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest();

/* → "scrypt:<N>:<r>:<p>:<salt>:<hash>", the salt and hash base64url. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), hash.toString("base64url")].join(":");
}

export function verifyPassword(candidate, stored) {
  const parts = String(stored).split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = scryptSync(String(candidate ?? ""), Buffer.from(salt, "base64url"), KEY_LENGTH, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

/* store: where a password set in Settings lives — db.password
 * ({hash() → string|null, set(hash)}). */
export function createAuth({ password, secret, store = { hash: () => null, set() {} } }) {
  const envDigest = sha256(password);
  /* The key follows the password in force: the one from Settings when there
   * is one, else the .env one — exactly the key sessions had before
   * Settings could change it, so they survive the upgrade. */
  const key = () => {
    const stored = store.hash();
    return createHmac("sha256", secret).update("session\0").update(stored ? `settings\0${stored}` : envDigest).digest();
  };
  const sign = (payload) => createHmac("sha256", key()).update(payload).digest("base64url");

  function checkPassword(candidate) {
    const stored = store.hash();
    if (stored) return verifyPassword(candidate, stored);
    // Digests, so the comparison is constant-time whatever the lengths.
    return timingSafeEqual(sha256(String(candidate ?? "")), envDigest);
  }

  return {
    checkPassword,

    /* From now on, `next` is the password; every session but the one issued
     * next is over. The caller has checked the current one. */
    setPassword(next) {
      store.set(hashPassword(next));
    },

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
