/* Entry point: read the environment, open the database, serve the pages,
 * and start the clock that sends the day's messages. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBridge } from "./bridge.mjs";
import { loadConfig } from "./config.mjs";
import { openDb } from "./db.mjs";
import { log } from "./log.mjs";
import { createScheduler } from "./scheduler.mjs";
import { createApp } from "./server.mjs";

const { config, problems } = loadConfig();

mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, "birthdays.db"), {
  defaultTimezone: problems.some((p) => p.startsWith("DEFAULT_TIMEZONE")) ? "Asia/Kolkata" : config.defaultTimezone,
});
const bridge = createBridge({ url: config.bridgeUrl, token: config.bridgeToken });
const scheduler = createScheduler({ db, bridge, log });
const server = await createApp({ config, problems, db, bridge, scheduler, log });

server.listen(config.port, config.host, () => {
  log.info({ port: config.port }, "listening");
});

if (problems.length) {
  // Nothing is sent from an app that is not set up; the one page it serves
  // says the same as these lines.
  for (const problem of problems) log.error(problem);
} else {
  if (!config.bridgeToken) log.warn("BRIDGE_TOKEN is not set, so WhatsApp cannot be reached. Run bash scripts/setup.sh, then docker compose up -d.");
  scheduler.start();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    log.info({ signal }, "stopping");
    scheduler.stop();
    server.close();
    db.close();
    process.exit(0);
  });
}
