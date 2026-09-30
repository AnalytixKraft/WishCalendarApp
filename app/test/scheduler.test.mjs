import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError } from "../src/bridge.mjs";
import { openDb } from "../src/db.mjs";
import { silentLog } from "../src/log.mjs";
import { MAX_ATTEMPTS, NotSendable, createScheduler } from "../src/scheduler.mjs";

const YOUTH = "120363000000000001@g.us";
const CHOIR = "120363000000000002@g.us";
// Ofcom's drama range (+44 7700 900xxx): numbers never given to anyone.
const ANU_PHONE = "447700900001";
const MY_PHONE = "447700900099";
const LINKED_PHONE = "447700900077";

/* Stands in for the WhatsApp bridge. Nothing here reaches WhatsApp. */
function fakeBridge() {
  return {
    state: "open",
    sent: [],
    failWith: new Map(), // chat id → error to throw
    async status() {
      return { state: this.state, me: this.state === "open" ? { id: `${LINKED_PHONE}:4@s.whatsapp.net`, name: "Linked" } : null };
    },
    async send({ chatId, text, key }) {
      if (this.failWith.has(chatId)) throw this.failWith.get(chatId);
      this.sent.push({ chatId, text, key });
      return { message_id: `M${this.sent.length}`, chat_id: chatId, deduplicated: false };
    },
  };
}

/* 2026-09-30, a Wednesday. 03:00 UTC is 08:30 in India.
 * Anu (30 Sep) is wished on her own number; Biju (30 Sep) in Youth;
 * Cara (30 Sep) has no "Send to" yet; Dev's birthday is tomorrow. */
function setup(now = "2026-09-30T03:00:00Z") {
  const db = openDb(":memory:");
  const bridge = fakeBridge();
  let clock = new Date(now);
  const scheduler = createScheduler({ db, bridge, log: silentLog, clock: () => clock, pause: async () => {}, gap: () => 0 });
  db.settings.save({ enabled: true, wishTime: "08:00", reminderTime: "07:00", timezone: "Asia/Kolkata", daysAhead: 1 });
  db.chats.remember([
    { id: YOUTH, subject: "Youth" },
    { id: CHOIR, subject: "Choir" },
  ]);
  const anu = db.people.create({ name: "Anu Joseph", day: 30, month: 9, year: 1996, phone: ANU_PHONE, sendTo: "direct", message: "Happy {ordinal_age}, {first_name}! 🎂" });
  const biju = db.people.create({ name: "Biju", day: 30, month: 9, sendTo: YOUTH });
  const cara = db.people.create({ name: "Cara", day: 30, month: 9 });
  const dev = db.people.create({ name: "Dev", day: 1, month: 10, sendTo: CHOIR });
  return { db, bridge, scheduler, anu, biju, cara, dev, at: (iso) => (clock = new Date(iso)) };
}

test("each wish goes once, to that person's own choice — a number or a group", async () => {
  const { bridge, scheduler, anu, biju } = setup();
  const first = await scheduler.run();
  assert.equal(first.outcome, "sent");
  assert.deepEqual(
    bridge.sent.map((s) => [s.key, s.chatId]),
    [
      [`wish:2026-09-30:${anu}`, `${ANU_PHONE}@s.whatsapp.net`],
      [`wish:2026-09-30:${biju}`, YOUTH],
    ],
  );
  assert.equal(bridge.sent[0].text, "Happy 30th, Anu! 🎂");
  assert.match(bridge.sent[1].text, /Happy birthday, \*Biju\*/);
  assert.equal((await scheduler.run()).outcome, "idle");
  assert.equal((await scheduler.run({ force: true })).outcome, "idle");
  assert.equal(bridge.sent.length, 2);
});

test("a person's own time wins over the wish time in Settings", async () => {
  const { db, bridge, scheduler, anu, at } = setup(); // 08:30 IST
  db.people.update(anu, { ...db.people.get(anu), sendTime: "09:30" });
  await scheduler.run();
  assert.deepEqual(bridge.sent.map((s) => s.text.slice(0, 12)), ["🎉 Happy bir"]); // Biju's only
  at("2026-09-30T04:01:00Z"); // 09:31 IST
  await scheduler.run();
  assert.equal(bridge.sent.length, 2);
  assert.equal(bridge.sent[1].text, "Happy 30th, Anu! 🎂");
});

test("an anniversary is wished like a birthday, with the anniversary default", async () => {
  const { db, bridge, scheduler } = setup();
  const couple = db.people.create({ kind: "anniversary", name: "Joseph & Mary", day: 30, month: 9, year: 2001, sendTo: CHOIR });
  await scheduler.run();
  const wish = bridge.sent.find((s) => s.key === `wish:2026-09-30:${couple}`);
  assert.equal(wish.chatId, CHOIR);
  assert.match(wish.text, /^💍 Happy anniversary, \*Joseph & Mary\*! 🎉/);
  db.settings.save({ anniversaryTemplate: "Happy {ordinal} anniversary, {name}!" });
  const again = db.people.create({ kind: "anniversary", name: "Tom & Ann", day: 30, month: 9, year: 2016, sendTo: CHOIR });
  await scheduler.run();
  assert.equal(bridge.sent.find((s) => s.key === `wish:2026-09-30:${again}`).text, "Happy 10th anniversary, Tom & Ann!");
});

test("someone with no “Send to” is listed, and never sent", async () => {
  const { scheduler, cara, bridge } = setup();
  await scheduler.run({ force: true });
  assert.ok(!bridge.sent.some((s) => s.key.endsWith(`:${cara}`)));
  const job = scheduler.agenda().find((j) => j.person?.id === cara);
  assert.equal(job.to, null);
});

test("the morning reminder lists every message of the day — time, where, what — before they go", async () => {
  const { db, bridge, scheduler, anu, at } = setup("2026-09-30T00:31:00Z"); // 06:01 IST
  db.settings.save({ reminderTo: "self", reminderTime: "06:00" });
  db.people.update(anu, { ...db.people.get(anu), sendTime: "09:30" });
  await scheduler.run();
  assert.equal(bridge.sent.length, 1);
  const [reminder] = bridge.sent;
  assert.equal(reminder.key, "reminder:2026-09-30");
  assert.equal(reminder.chatId, `${LINKED_PHONE}@s.whatsapp.net`, "to the linked phone itself");
  assert.equal(
    reminder.text,
    [
      "🎉 *Today's wishes* · Wed 30 Sep",
      "",
      "• *08:00* → Youth — 🎂 Biju",
      "> 🎉 Happy birthday, *Biju*! 🎂",
      "> Wishing you a wonderful year ahead, full of joy, good health and blessings. Have a lovely day! 🥳",
      "",
      "⚠️ 🎂 Cara — no “Send to” chosen, so nothing will be sent",
      "",
      "• *09:30* → +447700900001 — 🎂 Anu Joseph (turns 30)",
      "> Happy 30th, Anu! 🎂",
      "",
      "*Coming up*",
      "• Tomorrow — 🎂 Dev",
    ].join("\n"),
  );
  at("2026-09-30T02:31:00Z"); // 08:01 IST: Biju's
  await scheduler.run();
  assert.equal(bridge.sent.length, 2);
});

test("the reminder can go to my number or a group instead, and nowhere by default", async () => {
  const { db, bridge, scheduler } = setup("2026-09-30T01:31:00Z"); // 07:01 IST
  await scheduler.run();
  assert.equal(bridge.sent.length, 0);
  db.settings.save({ reminderTo: "direct", myPhone: MY_PHONE });
  await scheduler.run();
  assert.deepEqual(bridge.sent.map((s) => s.chatId), [`${MY_PHONE}@s.whatsapp.net`]);
});

test("paused sends nothing on its own; Send today's messages now still does", async () => {
  const { db, bridge, scheduler } = setup();
  db.settings.save({ enabled: false });
  assert.equal((await scheduler.run()).outcome, "paused");
  assert.equal(bridge.sent.length, 0);
  assert.equal((await scheduler.run({ force: true })).outcome, "sent");
  assert.equal(bridge.sent.length, 2);
});

test("WhatsApp not connected: nothing attempted, no try used up", async () => {
  const { db, bridge, scheduler, anu } = setup();
  bridge.state = "idle";
  const result = await scheduler.run();
  assert.equal(result.outcome, "waiting");
  assert.match(result.detail, /not connected/);
  assert.equal(db.deliveries.get(`wish:2026-09-30:${anu}`), null);
  assert.ok(scheduler.last.waiting);
  bridge.state = "open";
  assert.equal((await scheduler.run()).outcome, "sent");
  assert.equal(scheduler.last.waiting, null);
});

test("a refused message is retried every 10 minutes, at most 6 times", async () => {
  const { db, bridge, scheduler, biju, at } = setup();
  bridge.failWith.set(YOUTH, new BridgeError({ code: "not_a_member" }));
  const key = `wish:2026-09-30:${biju}`;
  assert.equal((await scheduler.run()).outcome, "failed");
  assert.equal(db.deliveries.get(key).attempts, 1);
  assert.match(db.deliveries.get(key).error, /not a member/);

  at("2026-09-30T03:09:00Z"); // 9 minutes on: too soon
  await scheduler.run();
  assert.equal(db.deliveries.get(key).attempts, 1);

  let t = Date.parse("2026-09-30T03:10:00Z");
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++, t += 10 * 60_000) {
    at(new Date(t).toISOString());
    await scheduler.run();
  }
  assert.equal(db.deliveries.get(key).attempts, MAX_ATTEMPTS);
  assert.equal(db.deliveries.get(key).status, "failed");

  bridge.failWith.clear();
  await scheduler.run({ force: true });
  assert.equal(db.deliveries.get(key).status, "sent");
});

test("a number that is not on WhatsApp fails that wish only", async () => {
  const { db, bridge, scheduler, anu, biju } = setup();
  bridge.failWith.set(`${ANU_PHONE}@s.whatsapp.net`, new BridgeError({ code: "not_on_whatsapp" }));
  const result = await scheduler.run();
  assert.equal(result.outcome, "failed");
  assert.match(db.deliveries.get(`wish:2026-09-30:${anu}`).error, /not on WhatsApp/);
  assert.equal(db.deliveries.get(`wish:2026-09-30:${biju}`).status, "sent");
});

test("a broken connection (or the hourly cap) mid-run stops the rest", async () => {
  const { bridge, scheduler } = setup();
  bridge.failWith.set(`${ANU_PHONE}@s.whatsapp.net`, new BridgeError({ code: "rate_limited", detail: "at most 30 direct messages an hour" }));
  const result = await scheduler.run();
  assert.equal(result.failed, 1);
  assert.equal(result.sent, 0); // Biju's was not tried
  assert.match(scheduler.last.waiting, /Too many direct messages/);
});

test("yesterday's messages are never sent today", async () => {
  const { db, bridge, scheduler } = setup("2026-09-30T18:40:00Z"); // 00:10 IST on 1 Oct
  db.settings.save({ wishTime: "00:05" });
  await scheduler.run();
  assert.equal(bridge.sent.length, 1);
  assert.match(bridge.sent[0].key, /^wish:2026-10-01:/);
  assert.match(bridge.sent[0].text, /Dev/);
});

test("29 February birthdays go out on 28 February in a common year", async () => {
  const { db, bridge, scheduler } = setup("2027-02-28T03:00:00Z");
  const leela = db.people.create({ name: "Leela", day: 29, month: 2, year: 2000, sendTo: YOUTH });
  await scheduler.run();
  assert.deepEqual(bridge.sent.map((s) => s.key), [`wish:2027-02-28:${leela}`]);
});

test("paused people are not wished", async () => {
  const { db, bridge, scheduler, anu } = setup();
  db.people.update(anu, { ...db.people.get(anu), active: false });
  await scheduler.run();
  assert.deepEqual(bridge.sent.map((s) => s.chatId), [YOUTH]);
});

test("Send now on the birthday is that day's wish: sent now, and not again", async () => {
  const { db, bridge, scheduler, anu } = setup("2026-09-30T01:00:00Z"); // 06:30 IST, before its time
  const result = await scheduler.sendNow(db.people.get(anu));
  assert.deepEqual([result.sentNow, result.birthday], [true, true]);
  assert.deepEqual(bridge.sent.map((s) => s.key), [`wish:2026-09-30:${anu}`]);
  assert.equal((await scheduler.sendNow(db.people.get(anu))).sentNow, false);
  await scheduler.run({ force: true });
  assert.equal(bridge.sent.filter((s) => s.key.endsWith(`:${anu}`)).length, 1);
});

test("Send now on another day is an extra message; the birthday's still goes", async () => {
  const { db, bridge, scheduler, dev, at } = setup(); // Dev's birthday is tomorrow
  const result = await scheduler.sendNow(db.people.get(dev));
  assert.deepEqual([result.sentNow, result.birthday], [true, false]);
  assert.match(bridge.sent[0].key, new RegExp(`^now:${dev}:`));
  assert.equal(bridge.sent[0].chatId, CHOIR);
  at("2026-10-01T03:00:00Z"); // his birthday, 08:30 IST
  await scheduler.run();
  assert.ok(bridge.sent.some((s) => s.key === `wish:2026-10-01:${dev}`));
});

test("Send now needs a “Send to”, and WhatsApp connected", async () => {
  const { db, bridge, scheduler, cara, anu } = setup();
  await assert.rejects(scheduler.sendNow(db.people.get(cara)), NotSendable);
  bridge.state = "idle";
  await assert.rejects(scheduler.sendNow(db.people.get(anu)), (err) => err instanceof BridgeError && err.code === "not_connected");
  assert.equal(bridge.sent.length, 0);
});

test("a preview goes to my number — or, without one, to the linked phone", async () => {
  const { db, bridge, scheduler, anu } = setup();
  await scheduler.sendPreview(db.people.get(anu));
  assert.equal(bridge.sent[0].chatId, `${LINKED_PHONE}@s.whatsapp.net`);
  assert.match(bridge.sent[0].text, /^👀 Preview — Anu Joseph gets this on Wed 30 Sep at 08:00, to \+447700900001:\n\nHappy 30th, Anu! 🎂$/);
  db.settings.save({ myPhone: MY_PHONE });
  await scheduler.sendPreview(db.people.get(anu));
  assert.equal(bridge.sent[1].chatId, `${MY_PHONE}@s.whatsapp.net`);
});
