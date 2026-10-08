/* The one kind of inbound message the bridge acts on: a "📅 message" — one
 * that starts with 📅 or 📆, in a chat the owner chose for them in the app's
 * Settings → Calendar: a group they ticked, where ANYONE in it may send one
 * (the owner's choice: a family's or a team's shared calendar), or the
 * linked account's own chat (Message yourself, "self"), where only it
 * writes. The app turns each into an event or a task.
 *
 * Which chats those are, the app says (POST /commands/chats); until it has,
 * after the bridge starts, there are none. A group not chosen is not even
 * decrypted (session.mjs, ignoresSender) — but for a quarter of an hour after
 * the bridge posts in it, so its members' phones can ask for a wish again;
 * then, as for everything else here, nothing is read.
 *
 * Everything that arrives is let go of as it arrives, unread beyond the
 * checks below and never kept, unless it is a 📅 message: every message in
 * a chat not chosen, and every message without the mark. At most
 * PER_CHAT_HOUR are taken from one chat an hour, so a group cannot flood the
 * calendar — or the chat its answers go to.
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
/* Any calendar emoji, anywhere: a message meant as a 📅 message that is not
 * one, said so in the log (never the message). */
const CALENDARS = /[\u{1F4C5}\u{1F4C6}\u{1F5D3}]/u;

const MAX_TEXT = 2_000;
/* A 📅 message delivered later than this after it was sent (the bridge was
 * down for days) is not acted on: whatever it was about may be long past. */
const MAX_AGE_MS = 2 * 24 * 60 * 60_000;
export const MAX_HELD = 100;
export const HOLD_MS = 3 * 24 * 60 * 60_000;
export const PER_CHAT_HOUR = 30;

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);
/* Who sent it, as they call themselves on WhatsApp — on one line, short. */
const nameOf = (name) => (typeof name === "string" ? name.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim().slice(0, 50) : "") || null;

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

/* A chat as the app names it when choosing: "self", or the group's id. */
export const chatKey = (chat, chatId) => (chat === "self" ? "self" : chatId);

/* A message as Baileys hands it over →
 *   {command}   a 📅 message, to hold for the app;
 *   {skipped}   a message in a chosen chat with a calendar emoji in it that
 *               is not one — why, in words, for the log;
 *   null        anything else.
 * `mine`: the linked account's own JIDs, normalised (its phone number and its
 * LID) — its own chat is either. `chats`: the chats chosen, as chatKey()
 * names them. */
export function readMessage(msg, mine, chats, now = Date.now()) {
  if (!msg?.key || !msg.message) return null;
  const chatId = msg.key.remoteJid ? jidNormalizedUser(msg.key.remoteJid) : "";
  const chat = isJidGroup(chatId) ? "group" : mine.has(chatId) ? "self" : null;
  if (!chat || !chats.has(chatKey(chat, chatId))) return null;
  const fromMe = msg.key.fromMe === true;
  if (chat === "self" && !fromMe) return null;
  const text = textOf(msg.message);
  if (text === null) return null;
  if (!MARK.test(text)) {
    if (!CALENDARS.test(text)) return null;
    return { skipped: /^\s*\u{1F5D3}/u.test(text) ? "it starts with 🗓️, which is not 📅 or 📆" : "the 📅 is not at the start" };
  }
  const sentAt = toNumber(msg.messageTimestamp) * 1000;
  if (!Number.isFinite(sentAt) || sentAt <= 0) return null;
  if (now - sentAt > MAX_AGE_MS) return { skipped: "it arrived more than 2 days after it was sent" };
  const quoted = contextOf(msg.message)?.quotedMessage;
  const quotedText = quoted ? textOf(quoted) : null;
  return {
    command: {
      id: String(msg.key.id),
      chat,
      chat_id: chatId,
      sent_at: new Date(sentAt).toISOString(),
      text: clip(text.replace(MARK, "").trim()),
      quoted: quotedText?.trim() ? clip(quotedText.trim()) : null,
      from_me: fromMe,
      sender: fromMe ? null : nameOf(msg.pushName),
    },
  };
}

/* The 📅 messages waiting for the app, oldest first. */
export class HeldCommands {
  #held = new Map(); // id → {command, until}
  #taken = new Map(); // chat id → when its messages were taken, this last hour

  #sweep(now) {
    for (const [id, { until }] of this.#held) if (until <= now) this.#held.delete(id);
  }

  /* → "held"; "again" when it was held already (WhatsApp can deliver a
   * message twice); "too_many" past PER_CHAT_HOUR from its chat. */
  add(command, now = Date.now()) {
    this.#sweep(now);
    if (this.#held.has(command.id)) return "again";
    const recent = (this.#taken.get(command.chat_id) ?? []).filter((at) => at > now - 60 * 60_000);
    if (recent.length >= PER_CHAT_HOUR) return "too_many";
    this.#taken.set(command.chat_id, [...recent, now]);
    this.#held.set(command.id, { command, until: now + HOLD_MS });
    while (this.#held.size > MAX_HELD) this.#held.delete(this.#held.keys().next().value);
    return "held";
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

  /* A chat no longer chosen: what came from it goes too. */
  keepOnly(chats) {
    for (const [id, { command }] of this.#held) if (!chats.has(chatKey(command.chat, command.chat_id))) this.#held.delete(id);
  }
}
