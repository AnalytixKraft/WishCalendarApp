/* The WhatsApp side of the bridge: one Baileys linked-device session, the
 * state machine around it, and the only things the API may ask of it — link
 * a phone, list the groups it is in, post text into a group or to a person by
 * phone number, and hand over the "📅 messages" the account's owner sent
 * (commands.mjs says exactly which messages those are, and nothing else
 * inbound is acted on).
 *
 * Adapted from the WhatsApp bridge AnalytixKraft runs for its bug tracker
 * (itself lifted from AnalytixKraft/medha), keeping only what a few messages
 * a day need: the multi-file auth store and its save queue, the creds.json
 * backup, QR pairing with the 515 restart, and a text send. Left behind on
 * purpose: every kind of media, polls, reactions, any message store, and
 * every inbound handler but the one for 📅 messages.
 *
 * States (the API reports them verbatim; whatsapp/README.md has the table):
 *   idle        no linked device, and NOT trying — no pairing churn against
 *               WhatsApp while nobody is at the phone
 *   pairing     a QR is being offered; `qr` holds it and it rotates
 *   connecting  have a linked device; connecting, or backing off between tries
 *   open        connected; `me` says as whom
 *   conflict    another client took this session over (440) — stopped, and
 *               deliberately not fighting for it
 * (`unconfigured` is main.mjs's: without a token this module is never loaded.)
 */

import { copyFile, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import makeWASocket, {
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { HeldCommands, commandOf } from "./commands.mjs";
import { BridgeError, TtlCache, baileysLog, log, withTimeout } from "./util.mjs";

/* auth/ under DATA_DIR — the `whatsapp_auth` volume in Docker — is the
 * linked-device session: a live credential for the WhatsApp account. */
const AUTH_DIR = join(process.env.DATA_DIR || "/data", "auth");
const CREDS = join(AUTH_DIR, "creds.json");
const CREDS_BACKUP = join(AUTH_DIR, "creds.json.bak");

/* What the phone's Settings → Linked devices list shows for this link. */
const DEVICE_NAME = "Wish Calendar";

const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
/* Baileys' own QR lifetimes (Socket/socket.js, with qrTimeout left unset):
 * the first QR lives 60 s, each later one 20 s, and after the refs WhatsApp
 * handed out run out (~2.5 min) it closes the socket with 408. */
const FIRST_QR_MS = 60_000;
const NEXT_QR_MS = 20_000;
/* Belt and braces over that 408: a pairing nobody finishes goes back to idle
 * even if WhatsApp never says so. */
const PAIRING_DEADLINE_MS = 3 * 60_000;
const VERSION_FETCH_MS = 5_000;
/* Under the app's 45 s read timeout (app/src/bridge.mjs), so the app hears
 * the bridge's own answer instead of timing out on its own. */
const SEND_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 30_000;
const LOGOUT_TIMEOUT_MS = 10_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const GROUP_METADATA_TTL_MS = 5 * 60_000;
/* Direct messages from an unofficial client to people who may never have
 * written to the number are what WhatsApp's spam detection looks for. A
 * birthday list sends a handful a day; this cap is for the day something
 * goes wrong — a loop, a leaked token — so it cannot turn into a burst. */
const DIRECT_PER_HOUR = 30;
/* Whether a number is on WhatsApp, and under which JID, asked once a day
 * per number rather than before every message. */
const LOOKUP_TTL_MS = 24 * 60 * 60_000;

const BAILEYS_VERSION = createRequire(import.meta.url)("@whiskeysockets/baileys/package.json").version;

/* What the bridge can do, in /status: post text, and hand over 📅 messages. */
const FEATURES = Object.freeze(["text", "commands"]);

/* Codes → names, for last_error and the log. 408 is both `timedOut` and
 * `connectionLost` in Baileys' enum; the message beside it disambiguates. */
const REASONS = {
  401: "loggedOut",
  403: "forbidden",
  408: "timedOut",
  411: "multideviceMismatch",
  428: "connectionClosed",
  440: "connectionReplaced",
  500: "badSession",
  503: "unavailableService",
  515: "restartRequired",
};

/* Baileys errors are Boom errors, of two kinds that keep their code in
 * different places:
 *  - a connection ending (the DisconnectReason codes above): output.statusCode.
 *  - WhatsApp answering a query — groupMetadata, the lookups inside a send —
 *    with an <error code=… text=…/> node. assertNodeErrorFree throws those as
 *    `new Boom(text, { data: +code })`: WhatsApp's code is in `data`, and
 *    output.statusCode is Boom's default 500. Read that 500 and a group we
 *    were removed from comes out as "500 badSession", which sends an admin
 *    off to unlink a perfectly healthy session.
 * (A close's `data` is never a number — the socket error, or the stanza.) */
function statusOf(err) {
  return err?.output?.statusCode ?? err?.status;
}

function queryCodeOf(err) {
  return Number.isInteger(err?.data) ? err.data : null;
}

function describe(err) {
  const message = err?.message || String(err);
  // A query error's text is already WhatsApp's own name for the code
  // ("403: forbidden"); the REASONS names are for connection closes only.
  const queryCode = queryCodeOf(err);
  if (queryCode !== null) return `${queryCode}: ${message}`;
  const code = statusOf(err);
  return code ? `${code}${REASONS[code] ? ` ${REASONS[code]}` : ""}: ${message}` : message;
}

/* describe(), for what sendMessage throws. A Boom made without a code of its
 * own reads as 500, which describe() names "badSession" — right for a
 * connection close, wrong here: what a send throws with 500 is Baileys' own
 * failure, and "badSession" would send an admin off to unlink a healthy
 * session over it. A query error keeps its own code, as in describe(); every
 * other close code keeps its name (428 connectionClosed is a real close,
 * mid-send). */
function describeSendFailure(err) {
  if (queryCodeOf(err) === null && statusOf(err) === 500) return `500: ${err?.message || String(err)}`;
  return describe(err);
}

/* The socket's own error (ENOTFOUND, EAI_AGAIN, ECONNREFUSED, ETIMEDOUT…)
 * when a connection died for want of a network. Baileys wraps it as the
 * close's `data`, and its getCodeFromWSError turns every one of them into 408
 * timedOut — the same code as a QR nobody scanned — so the code alone cannot
 * tell "no network" from "nobody at the phone". */
function networkCause(err) {
  const code = err?.data?.code;
  return typeof code === "string" && /^E[A-Z_]+$/.test(code) ? code : null;
}

/* For work started with no caller waiting on it: a failure is logged, never
 * an unhandled rejection. */
function logFailure(what) {
  return (err) => log.error({ err: describe(err) }, `failed while ${what}`);
}

/* A person's number in the log: enough to tell two apart, not enough to
 * dial. */
function masked(jid) {
  const digits = String(jid).split("@")[0];
  return `…${digits.slice(-4)}`;
}

function meOf(me) {
  return me?.id ? { id: jidNormalizedUser(me.id), name: me.name || null } : null;
}

/* Our own JIDs, normalised: the phone-number one and, since WhatsApp's LID
 * migration, the LID one. A group lists each member under one or the other. */
function myJids(sock) {
  return new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNormalizedUser));
}

function findMe(meta, mine) {
  return meta.participants.find((p) => [p.id, p.phoneNumber, p.lid].some((j) => j && mine.has(jidNormalizedUser(j))));
}

/* Baileys' `shouldIgnoreJid`: true drops an inbound message, call, receipt or
 * notification from that JID BEFORE its content is decrypted or decoded:
 * only the envelope (from, id) has been read, and Baileys acks it (a nack,
 * 500) and stops (Socket/messages-recv.js, processNode). Having no
 * messages.upsert handler is NOT that: Baileys decrypts and decodes every
 * message it is handed whether or not anyone listens for the result — and
 * answers one it cannot decrypt with a retry receipt, so a stranger could
 * even make the bridge write back. Without this, anyone who can write to
 * the linked number feeds bytes to libsignal and the protobuf decoders in a
 * pre-release library — an entry point no app login or Cloudflare Access
 * challenge stands in front of.
 *
 * Kept:
 *   - groups, because the send depends on them. The delivery receipts, the
 *     retry receipts a member's phone sends when it cannot decrypt a message
 *     (Baileys answers those by re-sending), and the membership changes the
 *     metadata cache listens for all carry the GROUP's JID.
 *   - the linked account itself, which is no stranger: the phone's own
 *     protocol messages (app-state keys) and device-list changes are
 *     Baileys' business, and starving it of them is a risk with no gain.
 *   - the people this bridge has sent a direct message to (`peers`: their
 *     phone-number JID and, once WhatsApp has told us, their LID). A 1:1
 *     message's receipts come from the person's own JID — among them the
 *     retry receipt their phone sends when it cannot decrypt the message,
 *     which Baileys answers by re-sending. Dropped, the message would sit on
 *     their phone as "Waiting for this message".
 * Dropped: everyone else — strangers' DMs, calls, status updates, broadcast
 * lists, channels, and other users' device and key-change notices. The send
 * needs none of these: it fetches device lists fresh (Baileys keeps them
 * 5 min), and a group member whose keys changed answers with a retry
 * receipt, which comes from the group's JID.
 * The server's own `@s.whatsapp.net` (pre-key top-ups and the like) is never
 * put to this; Baileys exempts it.
 *
 * NOT closed: messages members post in a group the number is in are still
 * decrypted, and so is a reply from someone it messaged directly. The hook
 * sees only a JID, and those share it with the receipts the send depends on.
 * Nothing acts on either: the one message the bridge acts on is a 📅 message
 * the linked account sent itself (commands.mjs), and everything else is let
 * go of unread.
 *
 * `me` is creds.me, read at each call: Baileys fills it in on the object
 * itself when a pairing succeeds. Before that (pairing) there is no "self",
 * and nothing but groups gets through — nothing else is needed to pair. */
export function ignoresSender(jid, me, peers = new Set()) {
  if (isJidGroup(jid)) return false;
  const from = jidDecode(jid);
  if (!from) return true;
  if (peers.has(`${from.user}@${from.server}`)) return false;
  // User AND server: a LID and a phone number are separate number spaces,
  // and the same digits in the other one are somebody else.
  const isSelf = [me?.id, me?.lid].some((own) => {
    const mine = own && jidDecode(own);
    return Boolean(mine) && mine.user === from.user && mine.server === from.server;
  });
  return !isSelf;
}

/* Read creds.json, falling back to the backup when it will not parse.
 * useMultiFileAuthState writes it with a plain writeFile, not an atomic
 * rename, so a kill mid-write — an OOM kill at mem_limit, `docker stop`'s
 * SIGKILL, a power cut — leaves it truncated. Baileys would then quietly
 * start from blank credentials, i.e. an unlinked phone and a QR to scan
 * again. */
async function readCreds() {
  for (const file of [CREDS, CREDS_BACKUP]) {
    let creds;
    try {
      creds = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (file === CREDS_BACKUP) {
      await copyFile(CREDS_BACKUP, CREDS);
      log.warn("creds.json was missing or unreadable (a write cut short?); restored the last good copy");
    }
    return creds;
  }
  return null;
}

export async function startSession() {
  const s = {
    state: "idle",
    since: new Date().toISOString(),
    me: null,
    qr: null,
    qrExpiresAt: null,
    lastError: null,
  };
  let sock = null;
  /* Bumped whenever a socket is started or retired. Every event handler
   * checks it, so a socket we have let go of — ended by /logout, replaced
   * after a 515 — can never move the state machine or write credentials. */
  let gen = 0;
  let reconnectTimer = null;
  let pairingTimer = null;
  let attempt = 0;
  let qrCount = 0;
  let waVersion = null;
  let versionCache = null;
  /* creds.json saves, strictly one at a time, so two quick updates cannot
   * interleave their writes. Also awaited before anything re-reads or wipes
   * the directory — see openSocket() and wipe(). */
  let credsQueue = Promise.resolve();
  /* The latest socket start (connect()), until its socket exists or it
   * bails. See wipe(). */
  let starting = Promise.resolve();
  const groupMetadata = new TtlCache(GROUP_METADATA_TTL_MS);
  const sent = new TtlCache(IDEMPOTENCY_TTL_MS);
  const inflight = new Map();
  /* Direct messages: whom we have written to (ignoresSender lets their
   * receipts through), when (the hourly cap), and which numbers WhatsApp
   * says it knows. Memory only: after a restart a person is let through
   * again from the next message to them on. */
  const peers = new Set();
  const directSentAt = [];
  const lookups = new TtlCache(LOOKUP_TTL_MS);
  /* 📅 messages from the account's owner, until the app takes them. */
  const held = new HeldCommands();
  /* pair(), logout() and the pairing deadline each read the state, await
   * (a socket ending, the directory being wiped), then act on what they
   * read. Run them one at a time, in arrival order, so none acts on a state
   * another is halfway through changing. Without this a /pair and an Unlink
   * arriving together leave a pairing socket running behind an `idle` that
   * nothing will ever end — rotating QRs nobody sees, recreating the auth
   * directory, and ~2.5 min later writing "pairing timed out" over the
   * Unlink. */
  let lifecycle = Promise.resolve();
  function exclusive(fn) {
    const run = lifecycle.then(fn);
    lifecycle = run.catch(() => {}); // one failure must not jam the ones queued behind it
    return run;
  }

  function setState(state, patch = {}) {
    const from = s.state;
    Object.assign(s, { state }, patch);
    if (state !== from) s.since = new Date().toISOString();
    if (state !== "pairing") {
      s.qr = null;
      s.qrExpiresAt = null;
      clearTimeout(pairingTimer);
      pairingTimer = null;
    }
    if (state === "idle" || state === "pairing") s.me = null;
    if (state !== from) log.info({ from, to: state }, "state");
  }

  function status() {
    return {
      state: s.state,
      me: s.me,
      qr: s.qr,
      qr_expires_at: s.qrExpiresAt,
      since: s.since,
      last_error: s.lastError,
      baileys_version: BAILEYS_VERSION,
      wa_version: waVersion ? waVersion.join(".") : null,
      features: FEATURES,
    };
  }

  function queueCredsSave(saveCreds) {
    credsQueue = credsQueue
      .then(async () => {
        // Keep the current creds.json as the backup first — but only if it
        // parses, so a torn file never overwrites the last good copy.
        try {
          JSON.parse(await readFile(CREDS, "utf8"));
          await copyFile(CREDS, CREDS_BACKUP);
        } catch {
          // Nothing good on disk yet (first save of a pairing).
        }
        await saveCreds();
      })
      .catch((err) => log.warn({ err: describe(err) }, "could not save WhatsApp credentials"));
  }

  async function wipe() {
    // A socket start still reading the directory first: useMultiFileAuthState
    // creates it, and a mkdir landing after the rm leaves an auth directory
    // behind an Unlink. Any start still running here has already been
    // retired — /pair, /logout and the deadline retire() before they wipe —
    // so it bails rather than connects, within the version fetch's 5 s.
    await starting;
    // Pending saves next: one landing after the rm would recreate a stale
    // creds.json inside the next pairing's fresh directory.
    await credsQueue;
    groupMetadata.clear();
    await rm(AUTH_DIR, { recursive: true, force: true });
  }

  /* End the current socket WITHOUT logging out (the link survives), and make
   * sure nothing it emits on the way down is acted on. */
  async function retire() {
    gen++;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const old = sock;
    sock = null;
    if (old) await withTimeout(old.end(undefined), 5_000).catch(() => {});
  }

  /* The WhatsApp Web version to announce. Baileys ships one, but WhatsApp
   * retires old client versions, so a months-old image would one day be
   * refused; fetchLatestBaileysVersion reads the current one from Baileys'
   * repository. It takes no timeout of its own and must never hold a
   * reconnect hostage, hence the race; the fetch it abandons just finishes
   * in the background. */
  async function currentWaVersion() {
    if (versionCache && Date.now() < versionCache.until) return versionCache.version;
    const fetched = await Promise.race([
      fetchLatestBaileysVersion().catch(() => null),
      new Promise((resolve) => setTimeout(resolve, VERSION_FETCH_MS, null)),
    ]);
    if (fetched?.isLatest) {
      versionCache = { version: fetched.version, until: Date.now() + 6 * 60 * 60_000 };
      return fetched.version;
    }
    const bundled = DEFAULT_CONNECTION_CONFIG.version;
    log.warn(`could not fetch the current WhatsApp Web version; using the one bundled with Baileys (${bundled.join(".")})`);
    // Retry the fetch in a while rather than on every reconnect.
    versionCache = { version: bundled, until: Date.now() + 10 * 60_000 };
    return bundled;
  }

  /* Every socket start goes through here, so wipe() can wait for the one in
   * progress. openSocket() never rejects: its failures become a state. */
  function connect() {
    starting = openSocket();
    return starting;
  }

  async function openSocket() {
    const myGen = ++gen;
    try {
      // A save queued by the previous socket (pair-success writes `me`) must
      // be on disk before we read it back, or the restart after pairing
      // would read blank credentials and offer a QR instead of logging in.
      await credsQueue;
      const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const version = await currentWaVersion();
      if (myGen !== gen) return; // retired while we waited: /logout, or shutdown
      waVersion = version;

      const socket = makeWASocket({
        version,
        logger: baileysLog,
        auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, baileysLog) },
        browser: [DEVICE_NAME, "Chrome", "1.0"],
        // Stay "offline", so the phone keeps getting its own notifications.
        markOnlineOnConnect: false,
        // Never pull the account's chat history into the bridge. Baileys logs
        // "DANGER: DISABLING ALL SYNC …" on every connect because of this:
        // history sync is also where it first learns LID↔phone-number
        // mappings. Accepted — sending to a group looks up any mapping it
        // lacks from the server (lid-mapping.js, getLIDsForPNs), and the
        // alternative is copying the linked account's recent chats into a
        // container whose one job is posting a few messages.
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        // No message store. WhatsApp asks for a re-send when a member's
        // device fails to decrypt; Baileys answers those from its own
        // in-memory cache of recent sends (enableRecentMessageCache, on by
        // default), so nothing has to be kept here.
        getMessage: async () => undefined,
        // Without this every group send first re-fetches the group's member
        // list from WhatsApp.
        cachedGroupMetadata: async (jid) => groupMetadata.get(jid),
        // What this bridge sends is not handed back to it as an incoming
        // message. Baileys does that (as 'append') only for a local message
        // store, which there is none of; off, a message it sends to its own
        // chat — "🗓️ Your day", an alert — can never be taken for one the
        // owner typed (commands.mjs). Re-sends to a member whose phone could
        // not decrypt come from a cache filled when sending, not from this.
        emitOwnEvents: false,
        // Everything inbound that is not a group, this account or someone it
        // wrote to is dropped undecrypted — ignoresSender, above, says what
        // that keeps and why.
        shouldIgnoreJid: (jid) => ignoresSender(jid, auth.creds.me, peers),
      });
      sock = socket;

      socket.ev.on("creds.update", () => {
        if (myGen === gen) queueCredsSave(saveCreds);
      });
      socket.ev.on("connection.update", (update) => {
        if (myGen === gen) onConnectionUpdate(myGen, socket, auth, update);
      });
      // The one inbound message acted on: a 📅 message the owner sent, from
      // the phone or another of their devices (commands.mjs, commandOf).
      // Held for the app; everything else is dropped here, unread beyond
      // that check. (Not listening is not the same as not decrypting:
      // shouldIgnoreJid above is what limits that.)
      socket.ev.on("messages.upsert", ({ messages }) => {
        if (myGen !== gen) return;
        try {
          const mine = myJids(socket);
          for (const message of messages) {
            const command = commandOf(message, mine);
            if (command && held.add(command)) log.info({ chat: command.chat, message_id: command.id }, "📅 message held for the app"); // never its text
          }
        } catch (err) {
          log.warn({ err: describe(err) }, "could not read an incoming message");
        }
      });
      // Membership or settings changed: forget what we cached, so the next
      // send re-reads it.
      socket.ev.on("groups.update", (updates) => {
        for (const u of updates) if (u.id) groupMetadata.delete(u.id);
      });
      socket.ev.on("group-participants.update", ({ id }) => groupMetadata.delete(id));
    } catch (err) {
      if (myGen !== gen) return;
      const why = `could not start a WhatsApp connection: ${describe(err)}`;
      log.error(why);
      if (s.state === "pairing") {
        setState("idle", { lastError: why });
      } else {
        scheduleReconnect(why);
      }
    }
  }

  function scheduleReconnect(why) {
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt++);
    setState("connecting", { lastError: why });
    log.warn({ retry_in_ms: delay }, `disconnected (${why}); reconnecting`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  function onConnectionUpdate(myGen, socket, auth, { connection, lastDisconnect, qr, isNewLogin }) {
    if (qr && s.state === "pairing") {
      qrCount++;
      s.qr = qr;
      s.qrExpiresAt = new Date(Date.now() + (qrCount === 1 ? FIRST_QR_MS : NEXT_QR_MS)).toISOString();
      log.info({ n: qrCount }, "pairing: QR issued"); // the count, never the QR
    }
    if (isNewLogin) {
      // Scanned. WhatsApp now closes this socket with 515 and expects a fresh
      // one with the new credentials; onClose does that.
      setState("connecting", { me: meOf(auth.creds.me) });
      log.info("pairing: the phone accepted the link; waiting for WhatsApp to restart the connection");
    }
    if (connection === "open") {
      attempt = 0;
      setState("open", { me: meOf(socket.user ?? auth.creds.me), lastError: null });
    }
    if (connection === "close") onClose(myGen, auth, lastDisconnect?.error).catch(logFailure("handling a disconnect"));
  }

  async function onClose(myGen, auth, err) {
    sock = null;
    const code = statusOf(err);
    const why = describe(err);
    const linked = Boolean(auth.creds.me?.id);

    if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
      // The link is dead on WhatsApp's side; the files would only fail again.
      await wipe();
      if (myGen !== gen) return;
      const lastError =
        code === DisconnectReason.loggedOut
          ? `WhatsApp logged this device out (${why}) — it was removed from the phone's Linked devices, or the phone went unused for too long. Link a phone again.`
          : `WhatsApp refused this number (${why}) — possibly banned. Link a different spare number.`;
      setState("idle", { lastError });
      log.error(lastError);
      return;
    }
    if (!linked) {
      // Still pairing when it closed: nothing worth keeping.
      await wipe();
      if (myGen !== gen) return;
      setState("idle", { lastError: pairingFailure(code, err, why) });
      log.warn({ err: why }, s.lastError); // `why` always: the sentence alone can hide the cause
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      // Someone else is using these credentials (the same volume on another
      // machine, a copied session). Reconnecting would just kick them off in
      // turn, forever, and drift both copies' encryption keys apart. Stop.
      const lastError =
        "another WhatsApp Web client took over this session (440 connectionReplaced). " +
        "Stop the other one, then `docker compose restart whatsapp` — or Unlink and link again.";
      setState("conflict", { lastError });
      log.error(lastError);
      return;
    }
    if (code === DisconnectReason.restartRequired) {
      // Routine: WhatsApp asks for this right after a pairing, and now and
      // then otherwise. Not a failure, so no backoff.
      setState("connecting");
      void connect();
      return;
    }
    scheduleReconnect(why);
  }

  /* Why a pairing ended, in words that point at the right fix. Only the close
   * Baileys sends when its QRs run out means "nobody scanned": 408 is also
   * what every network failure becomes (see networkCause), and calling one of
   * those a scan timeout sends someone to stand at the phone when the problem
   * is the host's DNS or firewall — and no QR was ever on screen. */
  function pairingFailure(code, err, why) {
    if (qrCount > 0 && code === DisconnectReason.timedOut && err?.message === "QR refs attempts ended") {
      return "pairing timed out: the QR was not scanned in time";
    }
    if (networkCause(err)) {
      return qrCount > 0
        ? `pairing failed: lost the connection to WhatsApp (${why})`
        : `pairing failed: could not reach WhatsApp (${why}) — check this computer's DNS and outbound access to web.whatsapp.com:443`;
    }
    return qrCount > 0 ? `pairing failed: ${why}` : `pairing failed before WhatsApp offered a QR: ${why}`;
  }

  /* Run through exclusive() only (see the API at the bottom). */
  async function pair() {
    if (s.state !== "idle") return status(); // pairing, connecting, open, conflict: nothing to start
    setState("pairing", { lastError: null });
    qrCount = 0;
    pairingTimer = setTimeout(
      () => exclusive(abandonPairing).catch(logFailure("abandoning the pairing")),
      PAIRING_DEADLINE_MS,
    );
    let myGen;
    try {
      // Nothing should still be running in `idle`; make sure anyway, since
      // two pairing sockets side by side would each rotate their own QR.
      await retire();
      myGen = gen;
      await wipe(); // a clean slate: a half-finished earlier pairing must not be mistaken for a session
    } catch (err) {
      setState("idle", { lastError: `could not clear the old session: ${describe(err)}` });
      return status();
    }
    // Shutdown (stop(), which does not queue) retired everything while we
    // waited: start nothing behind its back.
    if (myGen !== gen) return status();
    void connect();
    return status();
  }

  async function abandonPairing() {
    if (s.state !== "pairing") return;
    await retire();
    await wipe();
    const minutes = PAIRING_DEADLINE_MS / 60_000;
    // No QR at all is not "nobody scanned": the connection never got that far.
    const lastError =
      qrCount > 0
        ? `pairing timed out: the QR was not scanned within ${minutes} minutes`
        : `pairing gave up: WhatsApp offered no QR within ${minutes} minutes — check this computer's outbound access to web.whatsapp.com:443`;
    setState("idle", { lastError });
    log.warn(lastError);
  }

  /* Run through exclusive() only (see the API at the bottom). */
  async function logout() {
    const hadDevice = Boolean(s.me);
    const live = s.state === "open" ? sock : null;
    let told = false;
    if (live) {
      // Tell WhatsApp first, so the phone's Linked devices list drops this
      // entry. Bump gen before it: logout() ends the socket with a 401, and
      // that must not be mistaken for WhatsApp logging us out.
      gen++;
      try {
        await withTimeout(live.logout(), LOGOUT_TIMEOUT_MS);
        told = true;
      } catch (err) {
        log.warn({ err: describe(err) }, "could not tell WhatsApp about the unlink");
      }
    }
    await retire();
    await wipe();
    const lastError =
      hadDevice && !told
        ? "unlinked here while WhatsApp could not be told, so the phone may still list this computer: remove it under Settings → Linked devices"
        : null;
    setState("idle", { lastError });
    log.info(told ? "unlinked: WhatsApp told, session wiped" : "unlinked: session wiped");
    return status();
  }

  function requireOpen() {
    if (s.state !== "open" || !sock) {
      throw new BridgeError(409, "not_connected", null, { state: s.state });
    }
    return sock;
  }

  async function groups() {
    const socket = requireOpen();
    let all;
    try {
      all = await withTimeout(socket.groupFetchAllParticipating(), QUERY_TIMEOUT_MS);
    } catch (err) {
      throw new BridgeError(502, "groups_failed", `could not list groups: ${describe(err)}`);
    }
    const mine = myJids(socket);
    return (
      Object.values(all)
        // A community's parent entry is a container, not a chat — nothing can
        // be posted to it. Its announcement group and sub-groups stay listed.
        .filter((g) => !g.isCommunity)
        .map((g) => {
          groupMetadata.set(g.id, g);
          return {
            id: g.id,
            subject: g.subject || "",
            participants: g.size ?? g.participants.length,
            announce: Boolean(g.announce),
            is_admin: Boolean(findMe(g, mine)?.admin),
          };
        })
        .sort((a, b) => a.subject.localeCompare(b.subject, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id))
    );
  }

  function deliver(socket, chatId, text) {
    return isJidGroup(chatId) ? deliverToGroup(socket, chatId, text) : deliverDirect(socket, chatId, text);
  }

  /* One text to one person, by phone number: only to a number WhatsApp
   * knows, only DIRECT_PER_HOUR an hour, and with that person's receipts let
   * through (ignoresSender). */
  async function deliverDirect(socket, chatId, text) {
    const hourAgo = Date.now() - 60 * 60_000;
    while (directSentAt.length && directSentAt[0] <= hourAgo) directSentAt.shift();
    if (directSentAt.length >= DIRECT_PER_HOUR) {
      throw new BridgeError(429, "rate_limited", `at most ${DIRECT_PER_HOUR} direct messages an hour`);
    }

    let target = lookups.get(chatId);
    if (target === undefined) {
      let found;
      try {
        [found] = (await withTimeout(socket.onWhatsApp(chatId), QUERY_TIMEOUT_MS)) || [];
      } catch (err) {
        throw new BridgeError(502, "send_failed", `could not look the number up on WhatsApp: ${describe(err)}`);
      }
      // WhatsApp's own JID for the number, which can differ from the digits
      // as typed (some countries' mobile prefixes).
      target = found?.exists ? jidNormalizedUser(found.jid) : false;
      lookups.set(chatId, target);
    }
    if (!target) {
      log.warn({ to: masked(chatId) }, "send refused: the number is not on WhatsApp");
      throw new BridgeError(404, "not_on_whatsapp");
    }

    const admit = (jid) => {
      const who = jid && jidDecode(jid);
      if (who) peers.add(`${who.user}@${who.server}`);
    };
    const lidOf = () => socket.signalRepository.lidMapping.getLIDForPN(target).catch(() => null);
    admit(target);
    admit(await lidOf());

    let msg;
    try {
      msg = await socket.sendMessage(target, { text, linkPreview: null }); // linkPreview: see deliverToGroup
    } catch (err) {
      throw new BridgeError(502, "send_failed", describeSendFailure(err));
    }
    directSentAt.push(Date.now());
    // The send looks the person's devices up, which is often when WhatsApp
    // first tells us their LID — and their receipts may come from that.
    admit(await lidOf());
    const messageId = msg?.key?.id;
    if (!messageId) throw new BridgeError(502, "send_failed", "WhatsApp returned no message id");
    log.info({ to: masked(chatId), message_id: messageId, kind: "text" }, "sent"); // never the text, never the whole number
    return { message_id: messageId, chat_id: chatId };
  }

  async function deliverToGroup(socket, chatId, text) {
    // Fresh metadata, not the cache: this runs a few times a day, and a stale
    // member list is exactly how "we were removed yesterday" turns into a
    // confusing send failure instead of a clear not_a_member. Caching it here
    // also hands sendMessage (via cachedGroupMetadata) the same fresh copy.
    let meta;
    try {
      meta = await socket.groupMetadata(chatId);
    } catch (err) {
      // WhatsApp answers a group we are not in (or that does not exist) with
      // an error node: 401/403 not-authorized/forbidden, 404 item-not-found.
      // Its code, not the connection's (queryCodeOf, above): a connection
      // dropped mid-query is a send_failed, and a 401/403 CLOSE is onClose's
      // to handle — "not a member" would misname a logged-out or banned
      // number.
      if ([401, 403, 404].includes(queryCodeOf(err))) {
        log.warn({ chat_id: chatId, err: describe(err) }, "send refused: not a member of the group");
        throw new BridgeError(403, "not_a_member");
      }
      throw new BridgeError(502, "send_failed", `could not read the group from WhatsApp: ${describe(err)}`);
    }
    groupMetadata.set(chatId, meta);
    const me = findMe(meta, myJids(socket));
    if (!me) {
      log.warn({ chat_id: chatId }, "send refused: not in the group's member list");
      throw new BridgeError(403, "not_a_member");
    }
    if (meta.announce && !me.admin) {
      log.warn({ chat_id: chatId }, "send refused: only admins can post in this group");
      throw new BridgeError(403, "admins_only");
    }
    let msg;
    try {
      // linkPreview: null, not left out. Left undefined, Baileys builds a
      // preview of the FIRST https URL in the text (Utils/messages.js,
      // generateWAMessageContent) — which in a message built from names
      // someone typed could be any URL at all. Today that only fails, because
      // its optional peer link-preview-js is not installed; install that
      // package one day "for nicer previews" and the bridge would start
      // fetching whatever URL a message carried, redirects followed. null
      // means: never try.
      msg = await socket.sendMessage(chatId, { text, linkPreview: null });
    } catch (err) {
      throw new BridgeError(502, "send_failed", describeSendFailure(err));
    }
    const messageId = msg?.key?.id;
    if (!messageId) throw new BridgeError(502, "send_failed", "WhatsApp returned no message id");
    log.info({ chat_id: chatId, message_id: messageId, kind: "text" }, "sent"); // never the text
    return { message_id: messageId, chat_id: chatId };
  }

  /* At most once per idempotency_key within 24 h — checked before the state,
   * so a retry after the connection dropped still gets the answer to the
   * send that DID go out instead of a 409. The cache is memory only: a bridge
   * restart forgets it, and the app's own delivery log is the guard that
   * stops a birthday wish going out twice. */
  async function send({ chatId, key, text }) {
    const done = sent.get(key);
    if (done) return { ...done, deduplicated: true };
    const seconds = SEND_TIMEOUT_MS / 1000;
    // The same key already on its way (a caller retrying after its own
    // timeout): wait for that send rather than making a second one — but no
    // longer than a send of its own would wait.
    const pending = inflight.get(key);
    if (pending) {
      const result = await withTimeout(
        pending,
        SEND_TIMEOUT_MS,
        () =>
          new BridgeError(
            502,
            "send_failed",
            `A send with this idempotency_key is still in flight and WhatsApp has not confirmed it within ${seconds} s. ` +
              "It may still arrive; retrying with the same idempotency_key will not post it twice.",
          ),
      );
      return { ...result, deduplicated: true };
    }

    const socket = requireOpen();
    const delivery = deliver(socket, chatId, text);
    inflight.set(key, delivery);
    // Record success whenever it lands — including after we have already
    // answered "timed out" below — so the retry that answer invites is
    // deduplicated instead of posting the message twice.
    delivery.then((result) => sent.set(key, result), () => {}).finally(() => inflight.delete(key));
    const result = await withTimeout(
      delivery,
      SEND_TIMEOUT_MS,
      () =>
        new BridgeError(
          502,
          "send_failed",
          `WhatsApp did not confirm the send within ${seconds} s. It may still arrive; ` +
            "retrying with the same idempotency_key will not post it twice.",
        ),
    );
    return { ...result, deduplicated: false };
  }

  /* `docker stop`: close the socket and flush credentials. Never a logout —
   * the link has to survive restarts, upgrades and reboots. */
  async function stop() {
    await retire();
    await credsQueue;
  }

  // On start: credentials on disk → reconnect with them; none → idle, and
  // wait for someone to link a phone.
  const creds = await readCreds();
  if (creds?.me?.id) {
    setState("connecting", { me: meOf(creds.me) });
    void connect();
  } else {
    if (creds) await wipe(); // a pairing that never finished: useless, and it would confuse the next one
    log.info("no linked device; idle until someone links one (the app's Settings → WhatsApp → Link a phone)");
  }

  // pair and logout queue behind each other (exclusive(), above). stop()
  // does not: shutdown must never wait out an unlink's 10 s.
  return {
    status,
    pair: () => exclusive(pair),
    logout: () => exclusive(logout),
    groups,
    send,
    commands: () => held.list(),
    ackCommands: (ids) => held.ack(ids),
    stop,
  };
}
