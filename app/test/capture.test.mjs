import assert from "node:assert/strict";
import { test } from "node:test";
import { createCapture, readCapture, renderCaptureReply } from "../src/capture.mjs";
import { openDb } from "../src/db.mjs";
import { silentLog } from "../src/log.mjs";
import { createScheduler } from "../src/scheduler.mjs";

// Thursday 8 October 2026, 10:00 in India.
const SENT = "2026-10-08T04:30:00.000Z";
const IST = { timeZone: "Asia/Kolkata" };
const read = (text, quoted = null, sentAt = SENT) => {
  const { notes, ...item } = readCapture({ text, quoted, sent_at: sentAt }, IST);
  return item;
};
const event = (title, day, time = "", extra = {}) => ({ kind: "event", title, day, endDay: null, time, endTime: "", why: null, ...extra });
const task = (title, due = null, why = null) => ({ kind: "task", title, due, why });

test("a 📅 message becomes an event: a day, a time, and the rest is its title", () => {
  const cases = [
    ["Dentist Tue 10am", event("Dentist", "2026-10-13", "10:00")],
    ["Dentist on Tuesday at 10am.", event("Dentist", "2026-10-13", "10:00")],
    ["Dinner Thu 8pm", event("Dinner", "2026-10-08", "20:00"), "today is Thursday"],
    ["Dinner at Ravi’s next Thu 8pm", event("Dinner at Ravi’s", "2026-10-15", "20:00"), "next: not today"],
    ["Team lunch tomorrow 1pm", event("Team lunch", "2026-10-09", "13:00")],
    ["Movie tonight 9.30pm", event("Movie", "2026-10-08", "21:30")],
    ["Lunch at noon", event("Lunch", "2026-10-08", "12:00")],
    ["Concert 12 Dec 7pm", event("Concert", "2026-12-12", "19:00")],
    ["Visit Oct 2", event("Visit", "2027-10-02"), "a day gone by this year is next year's"],
    ["Wedding 5 Jan 2027", event("Wedding", "2027-01-05")],
    ["Leap 29 Feb", event("Leap", "2028-02-29")],
    ["Flight 2026-11-02 06:15", event("Flight", "2026-11-02", "06:15")],
    ["Exam 20/10", event("Exam", "2026-10-20"), "day first"],
    ["Meeting 10:00-10:45 on Monday", event("Meeting", "2026-10-12", "10:00", { endTime: "10:45" })],
    ["Choir Sat 6-8pm", event("Choir", "2026-10-10", "18:00", { endTime: "20:00" })],
    ["Doctor 11-1pm Fri", event("Doctor", "2026-10-09", "11:00", { endTime: "13:00" })],
    ["Trip to Munnar 10-13 Oct", event("Trip to Munnar", "2026-10-10", "", { endDay: "2026-10-13" })],
    ["Holiday 3rd to 7th November", event("Holiday", "2026-11-03", "", { endDay: "2026-11-07" })],
    ["Trip 30 Dec - 2 Jan", event("Trip", "2026-12-30", "", { endDay: "2027-01-02" })],
    ["Call Mum 6:30pm", event("Call Mum", "2026-10-08", "18:30"), "a time and no day: that day"],
    ["Call Mum 9am", event("Call Mum", "2026-10-09", "09:00"), "…or the next, when it had passed"],
    ["Tue 10am", event("Untitled", "2026-10-13", "10:00")],
  ];
  for (const [text, expected, why] of cases) assert.deepEqual(read(text), expected, `${text}${why ? ` (${why})` : ""}`);
});

test("…or a task: when it says so, when it is due by a day, or when it has no day or time", () => {
  assert.deepEqual(read("task Pay rent by Fri"), task("Pay rent", "2026-10-09"));
  assert.deepEqual(read("todo: renew the car insurance"), task("renew the car insurance"));
  assert.deepEqual(read("Pay bill by 15/10"), task("Pay bill", "2026-10-15"));
  assert.deepEqual(read("Renew passport due 20 Oct"), task("Renew passport", "2026-10-20"));
  assert.deepEqual(read("Buy batteries"), task("Buy batteries", null, "There was no day or time in it, so it is a task."));
  assert.deepEqual(read("Bad 31/02"), task("Bad 31/02", null, "There was no day or time in it, so it is a task."), "no such day");
});

test("a reply of 📅 takes the day, time and title from the message it replies to — and keeps that message", () => {
  assert.deepEqual(read("", "Choir moves to Sat 6pm"), event("Choir moves", "2026-10-10", "18:00"));
  assert.deepEqual(read("choir practice", "We meet Sat 6-8pm at the hall"), event("choir practice", "2026-10-10", "18:00", { endTime: "20:00" }), "your words are the title");
  assert.deepEqual(read("Sun 5pm", "Shall we do the clean-up?"), event("Shall we do the clean-up?", "2026-10-11", "17:00"), "your day, their words");
  const full = readCapture({ text: "", quoted: "Choir moves to Sat 6pm\nBring the new music", sent_at: SENT }, { ...IST, where: "St. Mary's Choir" });
  assert.equal(full.notes, "Choir moves to Sat 6pm\nBring the new music\n\nFrom WhatsApp: St. Mary's Choir");
  assert.equal(readCapture({ text: "Lunch 1pm", quoted: null, sent_at: SENT }, IST).notes, "From WhatsApp: Message yourself");
});

test("days are read from when it was sent, not from when it is read", () => {
  // Sent Wednesday evening, read Thursday: "tomorrow" is Thursday.
  assert.equal(read("Lunch tomorrow 1pm", null, "2026-10-07T14:00:00.000Z").day, "2026-10-08");
});

test("the answer says what was added, and can never be taken for a 📅 message", () => {
  const trip = readCapture({ text: "Trip to Munnar 10-13 Oct", quoted: null, sent_at: SENT }, IST);
  assert.equal(renderCaptureReply(trip), "✅ Added to your calendar: *Trip to Munnar*\nSat 10 Oct – Tue 13 Oct, all day\n\nNot right? Change it in Wish Calendar → Calendar.");
  const batteries = readCapture({ text: "Buy batteries", quoted: null, sent_at: SENT }, IST);
  assert.match(renderCaptureReply(batteries), /^✅ Added a task: \*Buy batteries\*\nThere was no day or time in it, so it is a task\./);
  for (const reply of [renderCaptureReply(trip), renderCaptureReply(batteries)]) assert.doesNotMatch(reply, /^\s*[📅📆]/u);
});

/* Stands in for the bridge, 📅 messages and all. Nothing reaches WhatsApp. */
function fakeBridge(held) {
  return {
    held,
    sent: [],
    acked: [],
    async status() {
      return { state: "open", me: { id: "447700900077:4@s.whatsapp.net", name: "Linked" } };
    },
    async send({ chatId, text, key }) {
      this.sent.push({ chatId, text, key });
      return { message_id: `M${this.sent.length}`, chat_id: chatId, deduplicated: false };
    },
    async commands() {
      return this.held;
    },
    async ackCommands(ids) {
      this.acked.push(...ids);
      this.held = this.held.filter((c) => !ids.includes(c.id));
      return { acked: ids.length };
    },
  };
}

function setup(held) {
  const db = openDb(":memory:");
  const bridge = fakeBridge(held);
  const clock = () => new Date("2026-10-08T05:00:00Z");
  const scheduler = createScheduler({ db, bridge, log: silentLog, clock, pause: async () => {}, gap: () => 0 });
  db.settings.save({ enabled: true, timezone: "Asia/Kolkata" });
  db.chats.remember([{ id: "120363000000000001@g.us", subject: "St. Mary's Choir" }]);
  return { db, bridge, capture: createCapture({ db, bridge, scheduler, log: silentLog, clock }) };
}

const command = (id, text, extra = {}) => ({ id, chat: "self", chat_id: "447700900077@s.whatsapp.net", sent_at: SENT, text, quoted: null, ...extra });

test("each 📅 message goes on the calendar once, is answered in Message yourself, and let go", async () => {
  const { db, bridge, capture } = setup([
    command("A", "Dentist Tue 10am"),
    command("B", "", { chat: "group", chat_id: "120363000000000001@g.us", quoted: "Choir moves to Sat 6pm" }),
    command("C", "Buy batteries"),
  ]);
  assert.equal(await capture.poll(), 3);
  const dentist = db.events.between("2026-10-13", "2026-10-13")[0];
  assert.deepEqual([dentist.title, dentist.time, dentist.notes], ["Dentist", "10:00", "From WhatsApp: Message yourself"]);
  assert.match(db.events.between("2026-10-10", "2026-10-10")[0].notes, /From WhatsApp: St\. Mary's Choir$/);
  assert.equal(db.tasks.open()[0].title, "Buy batteries");
  assert.deepEqual(
    bridge.sent.map((s) => [s.key, s.chatId]),
    [
      ["capture:A", "447700900077@s.whatsapp.net"],
      ["capture:B", "447700900077@s.whatsapp.net"],
      ["capture:C", "447700900077@s.whatsapp.net"],
    ],
    "every answer to the linked phone itself — never the group",
  );
  assert.equal(db.deliveries.get("capture:A").title, "Dentist");
  assert.deepEqual(bridge.acked, ["A", "B", "C"]);

  // Held again (the ack did not land): taken once all the same.
  bridge.held = [command("A", "Dentist Tue 10am")];
  assert.equal(await capture.poll(), 0);
  assert.equal(db.events.between("2026-10-13", "2026-10-13").length, 1);
  assert.equal(bridge.sent.length, 3);
});

test("switched off, 📅 messages are let go and nothing is added; paused, they are still answered", async () => {
  const off = setup([command("A", "Dentist Tue 10am")]);
  off.db.settings.save({ capture: false });
  assert.equal(await off.capture.poll(), 0);
  assert.deepEqual([off.db.events.count(), off.bridge.sent.length, off.bridge.acked], [0, 0, ["A"]]);

  const paused = setup([command("A", "Dentist Tue 10am")]);
  paused.db.settings.save({ enabled: false });
  assert.equal(await paused.capture.poll(), 1);
  assert.equal(paused.bridge.sent.length, 1, "it answers something its owner just did");
});

test("a bridge without 📅 messages (or not there at all) is no error", async () => {
  const { capture, bridge } = setup([]);
  bridge.commands = async () => {
    throw Object.assign(new Error("no"), { code: "not_found" });
  };
  assert.equal(await capture.poll(), 0);
  assert.equal(await capture.poll(), 0);
});
