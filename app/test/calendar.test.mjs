import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError } from "../src/bridge.mjs";
import { eventsOn, occurrencesBetween, startsBetween } from "../src/calendar.mjs";
import { openDb } from "../src/db.mjs";
import { silentLog } from "../src/log.mjs";
import { createScheduler } from "../src/scheduler.mjs";

const YOUTH = "120363000000000001@g.us";
// Ofcom's drama range (+44 7700 900xxx): numbers never given to anyone.
const MY_PHONE = "447700900099";
const LINKED_PHONE = "447700900077";
const SELF = `${LINKED_PHONE}@s.whatsapp.net`;

const event = (fields) => ({ title: "x", endDay: null, time: "", endTime: "", repeat: "", repeatUntil: null, remind: null, notes: "", ...fields });

test("which days an event falls on: once, daily until, weekly, monthly, yearly", () => {
  assert.deepEqual(startsBetween(event({ day: "2026-10-08" }), "2026-10-01", "2026-10-31"), ["2026-10-08"]);
  assert.deepEqual(startsBetween(event({ day: "2026-11-08" }), "2026-10-01", "2026-10-31"), []);
  assert.deepEqual(startsBetween(event({ day: "2026-10-29", repeat: "daily", repeatUntil: "2026-11-01" }), "2026-10-30", "2026-11-30"), [
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
  ]);
  assert.deepEqual(startsBetween(event({ day: "2026-09-02", repeat: "weekly" }), "2026-10-01", "2026-10-31"), ["2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28"]);
  assert.deepEqual(startsBetween(event({ day: "2026-01-31", repeat: "monthly" }), "2026-02-01", "2026-04-30"), ["2026-02-28", "2026-03-31", "2026-04-30"], "the 31st, or the month's last day");
  assert.deepEqual(startsBetween(event({ day: "2024-02-29", repeat: "yearly" }), "2025-01-01", "2028-12-31"), ["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  assert.deepEqual(startsBetween(event({ day: "2026-10-08", repeat: "weekly" }), "2026-09-01", "2026-10-07"), [], "never before it starts");
});

test("an event over several days is on each of them, and says which day it is", () => {
  const trip = event({ title: "Trip", day: "2026-10-10", endDay: "2026-10-13" });
  assert.deepEqual(occurrencesBetween(trip, "2026-10-12", "2026-10-12"), [{ start: "2026-10-10", end: "2026-10-13" }]);
  assert.deepEqual(occurrencesBetween(trip, "2026-10-14", "2026-10-20"), []);
  const walk = event({ title: "Walk", day: "2026-10-01", repeat: "daily", time: "06:15" });
  const lunch = event({ title: "Lunch", day: "2026-10-12", time: "13:00" });
  assert.deepEqual(
    eventsOn([lunch, walk, trip], "2026-10-12").map((o) => [o.event.title, o.dayOf, o.days]),
    [["Trip", 3, 4], ["Walk", 1, 1], ["Lunch", 1, 1]],
    "all day first, then by time",
  );
});

/* Stands in for the WhatsApp bridge. Nothing here reaches WhatsApp. */
function fakeBridge() {
  return {
    sent: [],
    failWith: new Map(),
    async status() {
      return { state: "open", me: { id: `${LINKED_PHONE}:4@s.whatsapp.net`, name: "Linked" } };
    },
    async send({ chatId, text, key }) {
      if (this.failWith.has(chatId)) throw this.failWith.get(chatId);
      this.sent.push({ chatId, text, key });
      return { message_id: `M${this.sent.length}`, chat_id: chatId, deduplicated: false };
    },
  };
}

/* 2026-09-30, a Wednesday; 01:30 UTC is 07:00 in India, the reminder time. */
function setup(now = "2026-09-30T01:30:00Z") {
  const db = openDb(":memory:");
  const bridge = fakeBridge();
  let clock = new Date(now);
  const scheduler = createScheduler({ db, bridge, log: silentLog, clock: () => clock, pause: async () => {}, gap: () => 0 });
  db.settings.save({ enabled: true, wishTime: "08:00", reminderTime: "07:00", timezone: "Asia/Kolkata", daysAhead: 1 });
  return { db, bridge, scheduler, at: (iso) => (clock = new Date(iso)) };
}

test("“Your day”: today's events, the tasks due and overdue, tomorrow's — to the linked phone, once", async () => {
  const { db, bridge, scheduler, at } = setup("2026-09-30T01:00:00Z"); // 06:30
  db.events.create({ title: "Dentist", day: "2026-09-30", time: "10:00", endTime: "10:45", remind: 60, notes: "Bring the X-rays." });
  db.events.create({ title: "Trip to Munnar", day: "2026-09-29", endDay: "2026-10-02" });
  db.events.create({ title: "Choir", day: "2026-09-23", time: "18:30", repeat: "weekly" });
  db.events.create({ title: "Lunch", day: "2026-10-01", time: "13:00" });
  db.tasks.create({ title: "Pay the bill", due: "2026-09-30" });
  db.tasks.create({ title: "Call the plumber", due: "2026-09-28" });
  db.tasks.create({ title: "Sort photos" });
  db.tasks.setDone(db.tasks.create({ title: "Already done", due: "2026-09-30" }), true);

  assert.equal((await scheduler.run()).outcome, "idle", "not before the reminder time");
  at("2026-09-30T01:30:00Z"); // 07:00
  await scheduler.run();
  assert.deepEqual(bridge.sent.map((s) => [s.key, s.chatId]), [["agenda:2026-09-30", SELF]]);
  assert.equal(
    bridge.sent[0].text,
    [
      "🗓️ *Your day* · Wed 30 Sep",
      "",
      "• All day Trip to Munnar (day 2 of 4)",
      "• *10:00–10:45* Dentist",
      "• *18:30* Choir",
      "",
      "*To do*",
      "• Call the plumber — overdue since Mon 28 Sep",
      "• Pay the bill",
      "",
      "*Tomorrow*",
      "• *13:00* Lunch",
    ].join("\n"),
  );
  assert.equal((await scheduler.run()).outcome, "idle", "once");

  at("2026-09-30T03:30:00Z"); // 09:00: an hour before the dentist
  await scheduler.run();
  assert.equal(bridge.sent[1].key, `event:1:2026-09-30:60`);
  assert.equal(bridge.sent[1].text, "⏰ *Dentist*\nToday, 10:00–10:45\n> Bring the X-rays.");
  assert.equal(db.deliveries.get("event:1:2026-09-30:60").title, "Dentist");
  assert.equal((await scheduler.run({ force: true })).outcome, "idle");
});

test("reminders a day or more ahead, past midnight, and for all-day events at the reminder time", async () => {
  const { db, bridge, scheduler, at } = setup("2026-09-30T00:30:00Z"); // 06:00
  db.settings.save({ calendarTo: "self" });
  const flight = db.events.create({ title: "Flight", day: "2026-10-01", time: "06:00", remind: 1440 });
  const late = db.events.create({ title: "Late show", day: "2026-10-01", time: "00:30", remind: 60 });
  const dinner = db.events.create({ title: "Dinner", day: "2026-10-02", remind: 2880 });
  db.events.create({ title: "No reminder", day: "2026-10-01", time: "06:00" });

  await scheduler.run();
  assert.deepEqual(bridge.sent.map((s) => s.key), [`event:${flight}:2026-10-01:1440`], "06:00, a day before 06:00");
  assert.equal(bridge.sent[0].text, "⏰ *Flight*\nTomorrow, 06:00");

  at("2026-09-30T01:30:00Z"); // 07:00
  await scheduler.run();
  assert.deepEqual(bridge.sent.slice(1).map((s) => s.key), ["agenda:2026-09-30", `event:${dinner}:2026-10-02:2880`]);
  assert.match(bridge.sent[1].text, /Nothing on the calendar today\.\n\n\*Tomorrow\*\n• \*00:30\* Late show\n• \*06:00\* Flight\n• \*06:00\* No reminder/);
  assert.equal(bridge.sent[2].text, "⏰ *Dinner*\nFri 2 Oct, all day");

  at("2026-09-30T18:00:00Z"); // 23:30
  await scheduler.run();
  assert.equal(bridge.sent.at(-1).key, `event:${late}:2026-10-01:60`);
  assert.equal(bridge.sent.at(-1).text, "⏰ *Late show*\nTomorrow, 00:30");
  assert.equal(bridge.sent.length, 4);
});

test("calendar messages go where Settings says — never with the wishes' reminder — and nowhere when off", async () => {
  const { db, bridge, scheduler } = setup("2026-09-30T03:00:00Z"); // 08:30
  db.chats.remember([{ id: YOUTH, subject: "Youth" }]);
  db.settings.save({ reminderTo: YOUTH, myPhone: MY_PHONE });
  db.people.create({ name: "Biju", day: 30, month: 9, sendTo: YOUTH, createdAt: "2026-09-01T00:00:00Z" });
  db.events.create({ title: "Private appointment", day: "2026-09-30", time: "17:00" });
  await scheduler.run();
  const to = new Map(bridge.sent.map((s) => [s.key, s.chatId]));
  assert.equal(to.get("reminder:2026-09-30"), YOUTH);
  assert.equal(to.get("agenda:2026-09-30"), SELF);
  assert.doesNotMatch(bridge.sent.find((s) => s.key === "reminder:2026-09-30").text, /Private appointment/);

  const other = setup("2026-09-30T03:00:00Z");
  other.db.settings.save({ calendarTo: "direct", myPhone: MY_PHONE });
  other.db.events.create({ title: "Dentist", day: "2026-09-30", time: "17:00" });
  await other.scheduler.run();
  assert.deepEqual(other.bridge.sent.map((s) => [s.key, s.chatId]), [["agenda:2026-09-30", `${MY_PHONE}@s.whatsapp.net`]]);

  const off = setup("2026-09-30T03:00:00Z");
  off.db.settings.save({ calendarTo: "" });
  off.db.events.create({ title: "Dentist", day: "2026-09-30", time: "10:00", remind: 0 });
  assert.equal((await off.scheduler.run()).outcome, "idle");
  assert.deepEqual(off.scheduler.agenda(), []);
});

test("a calendar reminder WhatsApp refuses is told about like a wish", async () => {
  const { db, bridge, scheduler } = setup("2026-09-30T03:30:00Z"); // 09:00
  db.settings.save({ calendarTo: "direct", myPhone: MY_PHONE, alertTo: "self" });
  db.events.create({ title: "Dentist", day: "2026-09-30", time: "10:00", remind: 60 });
  bridge.failWith.set(`${MY_PHONE}@s.whatsapp.net`, new BridgeError({ code: "not_on_whatsapp", status: 404 }));
  const result = await scheduler.run();
  assert.equal(result.failed, 2, "“Your day” and the reminder");
  const alert = bridge.sent.find((s) => s.chatId === SELF);
  assert.match(alert.text, /^⚠️ \*Wish Calendar: 2 messages were not sent\*/);
  assert.match(alert.text, /🗓️ \*Your day\* → \+447700900099 · 07:00/);
  assert.match(alert.text, /⏰ \*Dentist\* → \+447700900099 · 09:00/);
});

test("paused, the calendar sends nothing — and Today still lists what it would", async () => {
  const { db, bridge, scheduler } = setup();
  db.settings.save({ enabled: false });
  db.events.create({ title: "Dentist", day: "2026-09-30", time: "10:00", remind: 60 });
  assert.equal((await scheduler.run()).outcome, "paused");
  assert.deepEqual(bridge.sent, []);
  assert.deepEqual(scheduler.agenda().map((job) => [job.kind, job.time, job.due]), [["agenda", "07:00", true], ["event", "09:00", false]]);
});
