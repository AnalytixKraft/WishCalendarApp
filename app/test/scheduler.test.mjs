import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError } from "../src/bridge.mjs";
import { openDb } from "../src/db.mjs";
import { silentLog } from "../src/log.mjs";
import { MAX_ATTEMPTS, createScheduler } from "../src/scheduler.mjs";

const YOUTH = "120363000000000001@g.us";
const CHOIR = "120363000000000002@g.us";
const ME = "120363000000000003@g.us";

function fakeBridge() {
  return {
    state: "open",
    sent: [],
    failWith: new Map(), // chat id → error to throw
    async status() {
      return { state: this.state };
    },
    async send({ chatId, text, key }) {
      if (this.failWith.has(chatId)) throw this.failWith.get(chatId);
      this.sent.push({ chatId, text, key });
      return { message_id: `M${this.sent.length}`, chat_id: chatId, deduplicated: false };
    },
  };
}

/* 2026-09-30, a Wednesday. 03:00 UTC is 08:30 in India. */
function setup(now = "2026-09-30T03:00:00Z") {
  const db = openDb(":memory:");
  const bridge = fakeBridge();
  let clock = new Date(now);
  const scheduler = createScheduler({ db, bridge, log: silentLog, clock: () => clock, pause: async () => {}, gap: () => 0 });
  db.settings.save({ enabled: true, wishTime: "08:00", reminderTime: "07:00", timezone: "Asia/Kolkata", daysAhead: 1 });
  db.chats.add({ id: YOUTH, subject: "Youth" });
  db.chats.add({ id: CHOIR, subject: "Choir" });
  const anu = db.people.create({ name: "Anu", day: 30, month: 9, year: 1996, chatIds: [YOUTH, CHOIR] });
  db.people.create({ name: "Biju", day: 1, month: 10, chatIds: [YOUTH] });
  return { db, bridge, scheduler, anu, at: (iso) => (clock = new Date(iso)) };
}

test("a wish goes out once, in each of the person's groups", async () => {
  const { bridge, scheduler } = setup();
  const first = await scheduler.run();
  assert.equal(first.outcome, "sent");
  assert.deepEqual(bridge.sent.map((s) => s.chatId).sort(), [CHOIR, YOUTH].sort());
  assert.match(bridge.sent[0].text, /Anu/);
  assert.equal((await scheduler.run()).outcome, "idle");
  assert.equal((await scheduler.run({ force: true })).outcome, "idle");
  assert.equal(bridge.sent.length, 2);
});

test("nothing before its time; the reminder at its own time", async () => {
  const { db, bridge, scheduler, at } = setup("2026-09-30T01:00:00Z"); // 06:30 IST
  db.chats.add({ id: ME, subject: "Me", wishes: false, reminders: true });
  assert.equal((await scheduler.run()).outcome, "idle");
  at("2026-09-30T01:31:00Z"); // 07:01 IST
  await scheduler.run();
  assert.deepEqual(bridge.sent.map((s) => s.key), [`reminder:2026-09-30:${ME}`]);
  assert.match(bridge.sent[0].text, /\*Today\*\n• Anu — turns 30\n {3}wished at 08:00 in Choir, Youth/);
  assert.match(bridge.sent[0].text, /Tomorrow — Biju/);
  at("2026-09-30T02:31:00Z"); // 08:01 IST
  await scheduler.run();
  assert.equal(bridge.sent.length, 3);
});

test("paused sends nothing on its own; Send now still does", async () => {
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
  assert.equal(db.deliveries.get(`wish:2026-09-30:${anu}:${YOUTH}`), null);
  assert.ok(scheduler.last.waiting);
  bridge.state = "open";
  assert.equal((await scheduler.run()).outcome, "sent");
  assert.equal(scheduler.last.waiting, null);
});

test("a refused message is retried every 10 minutes, at most 6 times", async () => {
  const { db, bridge, scheduler, anu, at } = setup();
  bridge.failWith.set(CHOIR, new BridgeError({ code: "not_a_member" }));
  const key = `wish:2026-09-30:${anu}:${CHOIR}`;
  assert.equal((await scheduler.run()).outcome, "failed");
  assert.equal(db.deliveries.get(key).attempts, 1);
  assert.match(db.deliveries.get(key).error, /not a member/);

  at("2026-09-30T03:09:00Z"); // 9 minutes on: too soon
  await scheduler.run();
  assert.equal(db.deliveries.get(key).attempts, 1);

  // Every 10 minutes after that, until the cap — and not past it.
  let t = Date.parse("2026-09-30T03:10:00Z");
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++, t += 10 * 60_000) {
    at(new Date(t).toISOString());
    await scheduler.run();
  }
  assert.equal(db.deliveries.get(key).attempts, MAX_ATTEMPTS);
  assert.equal(db.deliveries.get(key).status, "failed");

  // Send now still tries, once the group is fixed.
  bridge.failWith.clear();
  await scheduler.run({ force: true });
  assert.equal(db.deliveries.get(key).status, "sent");
});

test("a broken connection mid-run stops the rest", async () => {
  const { bridge, scheduler } = setup();
  bridge.failWith.set(CHOIR, new BridgeError({ code: "not_connected", state: "connecting" }));
  bridge.failWith.set(YOUTH, new BridgeError({ code: "not_connected", state: "connecting" }));
  const result = await scheduler.run();
  assert.equal(result.outcome, "failed");
  assert.equal(result.failed, 1); // the first; the second was not tried
  assert.match(scheduler.last.waiting, /not connected/);
});

test("yesterday's messages are never sent today", async () => {
  const { db, bridge, scheduler } = setup("2026-09-30T18:40:00Z"); // 00:10 IST on 1 Oct
  db.settings.save({ wishTime: "00:05" });
  await scheduler.run();
  // Anu's wishes (30 Sep) never went out, and now never will; Biju's did.
  assert.equal(bridge.sent.length, 1);
  assert.match(bridge.sent[0].key, /^wish:2026-10-01:/);
  assert.match(bridge.sent[0].text, /Biju/);
});

test("29 February birthdays go out on 28 February in a common year", async () => {
  const { db, bridge, scheduler } = setup("2027-02-28T03:00:00Z");
  const leapling = db.people.create({ name: "Leela", day: 29, month: 2, year: 2000, chatIds: [YOUTH] });
  await scheduler.run();
  assert.deepEqual(bridge.sent.map((s) => s.key), [`wish:2027-02-28:${leapling}:${YOUTH}`]);
  assert.match(bridge.sent[0].text, /Leela/);
});

test("someone not wished in a group is not wished there; paused people not at all", async () => {
  const { db, bridge, scheduler, anu } = setup();
  db.people.update(anu, { name: "Anu", day: 30, month: 9, year: 1996, active: true, chatIds: [CHOIR] });
  db.people.create({ name: "Paused Pat", day: 30, month: 9, active: false, chatIds: [YOUTH] });
  await scheduler.run();
  assert.deepEqual(bridge.sent.map((s) => s.chatId), [CHOIR]);
});

test("a group's own message wins over the default", async () => {
  const { db, bridge, scheduler } = setup();
  db.chats.update(YOUTH, { wishes: true, reminders: false, template: "Happy {ordinal_age}, {first_name}! — {group}" });
  await scheduler.run();
  const youth = bridge.sent.find((s) => s.chatId === YOUTH);
  assert.equal(youth.text, "Happy 30th, Anu! — Youth");
});

test("the agenda shows each message and where it stands", async () => {
  const { scheduler } = setup("2026-09-30T02:00:00Z"); // 07:30 IST
  let agenda = scheduler.agenda();
  assert.equal(agenda.length, 2);
  assert.ok(agenda.every((job) => job.kind === "wish" && !job.due && !job.delivery));
  await scheduler.run({ force: true });
  agenda = scheduler.agenda();
  assert.ok(agenda.every((job) => job.delivery.status === "sent"));
});
