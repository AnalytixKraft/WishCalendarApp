import assert from "node:assert/strict";
import { test } from "node:test";
import { HOLD_MS, HeldCommands, MAX_HELD, commandOf } from "../src/commands.mjs";

// Made-up JIDs: a group, the linked account (its number — Ofcom's drama
// range — and its LID), and someone else.
const GROUP = "120363000000000001@g.us";
const ME = "447700900077@s.whatsapp.net";
const MY_LID = "123456789012345@lid";
const OTHER = "447700900001@s.whatsapp.net";
const mine = new Set([ME, MY_LID]);
const NOW = Date.parse("2026-10-08T10:00:00Z");
const sent = (minutesAgo = 1) => Math.floor((NOW - minutesAgo * 60_000) / 1000);

const message = ({ fromMe = true, chat = GROUP, text = "📅 Dentist Tue 10am", at = sent(), id = "3EB0A1", content } = {}) => ({
  key: { id, fromMe, remoteJid: chat },
  messageTimestamp: at,
  message: content ?? { conversation: text },
});

test("the owner's 📅 message in a group, or in their own chat, is held for the app", () => {
  assert.deepEqual(commandOf(message(), mine, NOW), {
    id: "3EB0A1",
    chat: "group",
    chat_id: GROUP,
    sent_at: "2026-10-08T09:59:00.000Z",
    text: "Dentist Tue 10am",
    quoted: null,
  });
  assert.equal(commandOf(message({ chat: ME }), mine, NOW).chat, "self");
  assert.equal(commandOf(message({ chat: MY_LID }), mine, NOW).chat, "self", "its own chat under its LID too");
  assert.equal(commandOf(message({ chat: "447700900077:12@s.whatsapp.net" }), mine, NOW).chat, "self", "from one of its devices");
  assert.equal(commandOf(message({ text: "📆Pay rent Fri" }), mine, NOW).text, "Pay rent Fri");
  assert.equal(commandOf(message({ text: "  📅️  Lunch 1pm " }), mine, NOW).text, "Lunch 1pm");
});

test("nothing anyone else sends is acted on — and nothing of the owner's without the mark", () => {
  assert.equal(commandOf(message({ fromMe: false }), mine, NOW), null, "someone else, in a group");
  assert.equal(commandOf(message({ fromMe: false, chat: OTHER }), mine, NOW), null, "someone else, directly");
  assert.equal(commandOf(message({ chat: OTHER }), mine, NOW), null, "the owner, to someone else");
  assert.equal(commandOf(message({ text: "Dentist on Tue 📅" }), mine, NOW), null, "the mark comes first");
  assert.equal(commandOf(message({ text: "🗓️ *Your day* · Thu 8 Oct" }), mine, NOW), null, "🗓️ is the app's own");
  assert.equal(commandOf(message({ chat: "status@broadcast" }), mine, NOW), null);
  assert.equal(commandOf(message({ chat: "120363000000000002@newsletter" }), mine, NOW), null);
  assert.equal(commandOf(message({ content: { reactionMessage: { text: "📅" } } }), mine, NOW), null);
  assert.equal(commandOf({ key: { fromMe: true, remoteJid: GROUP } }, mine, NOW), null, "no content");
  assert.equal(commandOf(message({ at: sent(3 * 24 * 60) }), mine, NOW), null, "delivered days late");
});

test("a reply of 📅 carries the line it replies to; wrapped and captioned messages count", () => {
  const reply = commandOf(
    message({
      content: {
        ephemeralMessage: {
          message: { extendedTextMessage: { text: "📅", contextInfo: { quotedMessage: { conversation: "Choir moves to Sat 6pm" } } } },
        },
      },
    }),
    mine,
    NOW,
  );
  assert.deepEqual([reply.text, reply.quoted], ["", "Choir moves to Sat 6pm"]);
  const captioned = commandOf(message({ content: { imageMessage: { caption: "📅 Concert 12 Dec 7pm" } } }), mine, NOW);
  assert.equal(captioned.text, "Concert 12 Dec 7pm");
  const long = commandOf(message({ text: `📅 ${"x".repeat(5000)}` }), mine, NOW);
  assert.equal(long.text.length, 2000);
});

test("held until the app takes them: each once, at most a hundred, for three days", () => {
  const held = new HeldCommands();
  const c = (id) => ({ id, chat: "self", chat_id: ME, sent_at: "", text: id, quoted: null });
  assert.equal(held.add(c("a"), NOW), true);
  assert.equal(held.add(c("a"), NOW), false, "delivered twice, held once");
  held.add(c("b"), NOW);
  assert.deepEqual(held.list(NOW).map((x) => x.id), ["a", "b"]);
  assert.equal(held.ack(["a", "zzz"]), 1);
  assert.deepEqual(held.list(NOW).map((x) => x.id), ["b"]);
  assert.deepEqual(held.list(NOW + HOLD_MS), [], "let go after three days");
  for (let i = 0; i < MAX_HELD + 5; i++) held.add(c(`n${i}`), NOW);
  const left = held.list(NOW);
  assert.equal(left.length, MAX_HELD);
  assert.equal(left[0].id, "n5", "the oldest go first");
});
