/* Entry point. Decides once, at start, whether this bridge may talk to
 * WhatsApp at all, then serves the API on :3000.
 *
 * Environment (docker-compose.yml, service `whatsapp`):
 *   BRIDGE_TOKEN   the shared secret the app sends as `Authorization: Bearer`.
 *                  From WHATSAPP_BRIDGE_TOKEN in .env. Missing or short → the
 *                  bridge runs `unconfigured` (below) rather than failing.
 * Everything else is fixed on purpose: the port (nothing publishes it), the
 * data directory (/data, the whatsapp_auth volume).
 */

import { createApi } from "./api.mjs";
import { log } from "./util.mjs";

const PORT = 3000;
const MIN_TOKEN_LENGTH = 32;

// Everything written under /data is a live credential for a WhatsApp
// account: owner-only, whatever mode a library asks for.
process.umask(0o077);

// Baileys has been known to leave a rejected promise behind on a flaky
// connection. Crashing for that would drop a working session and churn
// reconnects against WhatsApp, so log it and carry on. A thrown exception is
// different — state is unknown — so that exits and Docker restarts us.
process.on("unhandledRejection", (err) => log.error({ err: err?.stack || String(err) }, "unhandled rejection"));
process.on("uncaughtException", (err) => {
  log.fatal({ err: err?.stack || String(err) }, "uncaught exception; exiting");
  process.exit(1);
});

// Trimmed, as the app trims its copy of the same value: a stray space around
// it in .env must not turn into a 401 on one side only.
const token = (process.env.BRIDGE_TOKEN || "").trim();
let session = null;

if (token.length < MIN_TOKEN_LENGTH) {
  // State `unconfigured`. Not an exit: a crash-looping container would be
  // noisier and no more useful than a clear line in the log. Said once.
  log.error(
    `BRIDGE_TOKEN is ${token ? `only ${token.length} characters (at least ${MIN_TOKEN_LENGTH} required)` : "not set"}, ` +
      "so this bridge will NOT connect to WhatsApp, and answers every call except /healthz with " +
      "503 bridge_token_not_configured. From the repo directory: `bash scripts/setup.sh` writes " +
      "WHATSAPP_BRIDGE_TOKEN into .env (it keeps any value that is already long enough), then " +
      "`docker compose up -d` recreates the app and the bridge with it (not `restart`, which keeps the old environment).",
  );
} else {
  // Loaded only now: an unconfigured bridge never so much as loads the
  // WhatsApp library, let alone opens a connection.
  const { startSession } = await import("./session.mjs");
  session = await startSession();
}

const server = createApi({ token, session });
server.listen(PORT, "0.0.0.0", () => {
  log.info({ port: PORT, state: session ? session.status().state : "unconfigured" }, "listening");
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, async () => {
    log.info({ signal }, "stopping");
    server.close();
    // Closes the socket and flushes credentials; never a logout — a restart
    // must come back linked. Docker's 10 s grace period is the upper bound.
    await session?.stop();
    process.exit(0);
  });
}
