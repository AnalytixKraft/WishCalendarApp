/* The app's environment (docker-compose.yml, service `app`, from .env).
 * Missing secrets are not a crash: the app serves one page that says what
 * to fix, and sends nothing, until they are set. */

import { isValidTimeZone } from "./dates.mjs";

export function loadConfig(env = process.env) {
  const config = {
    port: Number(env.PORT) || 3210,
    host: env.HOST || "0.0.0.0",
    dataDir: env.DATA_DIR || "/data",
    // The trailing dot makes the name absolute: it never walks the host's
    // search domains, so a stopped bridge fails closed instead of the token
    // going to whatever answers whatsapp.<search-domain>.
    bridgeUrl: (env.BRIDGE_URL || "http://whatsapp.:3000").replace(/\/+$/, ""),
    bridgeToken: (env.BRIDGE_TOKEN || "").trim(),
    adminPassword: (env.ADMIN_PASSWORD || "").trim(),
    sessionSecret: (env.SESSION_SECRET || "").trim(),
    defaultTimezone: (env.DEFAULT_TIMEZONE || "").trim() || "Asia/Kolkata",
  };
  const problems = [];
  if (config.adminPassword.length < 8) problems.push("ADMIN_PASSWORD is missing or shorter than 8 characters.");
  if (config.sessionSecret.length < 32) problems.push("SESSION_SECRET is missing or shorter than 32 characters.");
  if (!isValidTimeZone(config.defaultTimezone)) {
    problems.push(`DEFAULT_TIMEZONE "${config.defaultTimezone}" is not a time zone this computer knows (try Asia/Kolkata).`);
  }
  return { config, problems };
}
