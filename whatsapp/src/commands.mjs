/* The one kind of inbound message the bridge acts on: a "📅 message" — one
 * the LINKED ACCOUNT ITSELF sent, from the phone or another of its devices,
 * into a group or into its own chat (Message yourself), that starts with 📅
 * or 📆. The app turns each into an event or a task on its calendar.
 *
 * Everything else that arrives is let go of as it arrives, unread beyond the
 * check below and never kept: every message from anyone else — so no one
 * else can put anything on the calendar — and the account's own messages
 * without the mark, or to anyone but a group or itself.
 *
 * A 📅 message is held in memory, never on disk, until the app takes it
 * (GET /commands) and says it has it (POST /commands/ack): at most MAX_HELD
 * of them, for at most HOLD_MS. A bridge restart forgets them.
 *
 * Its text, and the text of the message it replies to — so a reply of just
 * 📅 to someone's "Choir moves to Sat 6pm" carries that line — goes to the
 * app and nowhere else: never into the log.
 *
 * The bridge's own messages (the morning "🗓️ Your day", alerts…) never come
 * back here: the socket is made with emitOwnEvents off (session.mjs). And
 * neither 🗓️ nor anything the app sends starts with 📅 or 📆, should that
 * ever change. */

import { isJidGroup, jidNormalizedUser, normalizeMessageContent, toNumber } from "@whiskeysockets/baileys";

/* 📅 (calendar) or 📆 (tear-off calendar), with or without the emoji
 * variation selector. Not 🗓️ (spiral calendar): "Your day" starts with it. */
export const MARK = /^\s*[\u{1F4C5}\u{1F4C6}]️?\s*/u;

const MAX_TEXT = 2_000;
/* A 📅 message delivered later than this after it was sent (the bridge was
 * down for days) is not acted on: whatever it was about may be long past. */
const MAX_AGE_MS = 2 * 24 * 60 * 60_000;
export const MAX_HELD = 100;
export const HOLD_MS = 3 * 24 * 60 * 60_000;

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

/* The text a message carries — typed, or as a caption — or null. */
function textOf(message) {
  const m = normalizeMessageContent(message);
  if (!m) return null;
  const text = m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption ?? m.documentMessage?.caption;
  return typeof text === "string" ? text : null;
}

function contextOf(message) {
  const m = normalizeMessageContent(message);
  return m?.extendedTextMessage?.contextInfo ?? m?.imageMessage?.contextInfo ?? m?.videoMessage?.contextInfo ?? null;
}

/* A message as Baileys hands it over → the 📅 message it is, or null.
 * `mine`: the linked account's own JIDs, normalised (its phone number and
 * its LID) — its own chat is either. */
export function commandOf(msg, mine, now = Date.now()) {
  if (msg?.key?.fromMe !== true || !msg.message) return null;
  const chatId = msg.key.remoteJid ? jidNormalizedUser(msg.key.remoteJid) : "";
  const chat = isJidGroup(chatId) ? "group" : mine.has(chatId) ? "self" : null;
  if (!chat) return null;
  const text = textOf(msg.message);
  if (text === null || !MARK.test(text)) return null;
  const sentAt = toNumber(msg.messageTimestamp) * 1000;
  if (!Number.isFinite(sentAt) || sentAt <= 0 || now - sentAt > MAX_AGE_MS) return null;
  const quoted = contextOf(msg.message)?.quotedMessage;
  const quotedText = quoted ? textOf(quoted) : null;
  return {
    id: String(msg.key.id),
    chat,
    chat_id: chatId,
    sent_at: new Date(sentAt).toISOString(),
    text: clip(text.replace(MARK, "").trim()),
    quoted: quotedText?.trim() ? clip(quotedText.trim()) : null,
  };
}

/* The 📅 messages waiting for the app, oldest first. */
export class HeldCommands {
  #held = new Map(); // id → {command, until}

  #sweep(now) {
    for (const [id, { until }] of this.#held) if (until <= now) this.#held.delete(id);
  }

  /* → false when it was held already (WhatsApp can deliver a message twice). */
  add(command, now = Date.now()) {
    this.#sweep(now);
    if (this.#held.has(command.id)) return false;
    this.#held.set(command.id, { command, until: now + HOLD_MS });
    while (this.#held.size > MAX_HELD) this.#held.delete(this.#held.keys().next().value);
    return true;
  }

  list(now = Date.now()) {
    this.#sweep(now);
    return [...this.#held.values()].map(({ command }) => command);
  }

  /* The app has these: let them go. → how many were still held */
  ack(ids) {
    let n = 0;
    for (const id of ids) if (this.#held.delete(id)) n++;
    return n;
  }
}
