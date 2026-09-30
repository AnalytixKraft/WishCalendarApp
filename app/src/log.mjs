/* One JSON object per line on stdout, in the same shape as the bridge's
 * (pino) lines, so `docker compose logs` reads the same for both.
 * Never logged: the password, the session cookie, the bridge token, a QR, or
 * what a message says. Keys and ids only. */

function write(level, fields, msg) {
  const [extra, text] = typeof fields === "string" ? [{}, fields] : [fields || {}, msg];
  process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), ...extra, ...(text ? { msg: text } : {}) })}\n`);
}

export const log = {
  info: (fields, msg) => write("info", fields, msg),
  warn: (fields, msg) => write("warn", fields, msg),
  error: (fields, msg) => write("error", fields, msg),
};

export const silentLog = { info() {}, warn() {}, error() {} };
