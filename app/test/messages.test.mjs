import assert from "node:assert/strict";
import { test } from "node:test";
import { upcomingBirthdays } from "../src/dates.mjs";
import {
  DEFAULT_ANNIVERSARY_TEMPLATE,
  DEFAULT_TEMPLATE,
  alertSummary,
  occasionNote,
  renderMissedAlert,
  renderRefusedAlert,
  renderReminder,
  renderTestAlert,
  renderWish,
} from "../src/messages.mjs";

const today = { year: 2026, month: 9, day: 30 };
const anu = { id: 1, kind: "birthday", name: "Anu Joseph", day: 30, month: 9, year: 1996 };
const biju = { id: 2, kind: "birthday", name: "Biju Thomas", day: 30, month: 9, year: null };
const couple = { id: 5, kind: "anniversary", name: "Joseph & Mary", day: 30, month: 9, year: 2001 };

test("the default wish names the person", () => {
  const text = renderWish(DEFAULT_TEMPLATE, { person: anu, date: today });
  assert.match(text, /^🎉 Happy birthday, \*Anu Joseph\*! 🎂\n\nWishing you/);
});

test("placeholders fill in, and a missing age leaves no gap behind", () => {
  const template = "Happy {ordinal_age} birthday, {first_name}! Turning {age} in {group} .";
  assert.equal(renderWish(template, { person: anu, date: today, groupName: "Youth" }), "Happy 30th birthday, Anu! Turning 30 in Youth.");
  assert.equal(renderWish(template, { person: biju, date: today, groupName: "Youth" }), "Happy birthday, Biju! Turning in Youth.");
});

test("unknown braces are left alone", () => {
  assert.equal(renderWish("Hi {name} {nickname}", { person: anu, date: today }), "Hi Anu Joseph {nickname}");
});

test("the reminder quotes each message, flags a missing “Send to”, and cuts a long one short", () => {
  const long = "x".repeat(300);
  const text = renderReminder({
    date: today,
    wishes: [
      { time: "00:00", to: { label: "Youth" }, person: anu, text: "Happy birthday!\n\nFrom all of us", sent: true },
      { time: "08:00", to: null, person: biju, text: "" },
      { time: "09:00", to: { label: "+447700900001" }, person: { ...biju, name: "Long" }, text: long, sent: false },
    ],
    later: upcomingBirthdays([{ id: 3, name: "Mary K", day: 1, month: 10, year: 1981 }], today, 3),
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "🎉 *Today's wishes* · Wed 30 Sep");
  assert.equal(lines[2], "✓ *00:00* → Youth — 🎂 Anu Joseph (turns 30) · sent");
  assert.deepEqual(lines.slice(3, 5), ["> Happy birthday!", "> From all of us"]);
  assert.equal(lines[6], "⚠️ 🎂 Biju Thomas — no “Send to” chosen, so nothing will be sent");
  assert.equal(lines[8], "• *09:00* → +447700900001 — 🎂 Long");
  assert.equal(lines[9].length, 2 + 240);
  assert.ok(lines[9].endsWith("…"));
  assert.deepEqual(lines.slice(-2), ["*Coming up*", "• Tomorrow — 🎂 Mary K (turns 45)"]);
});

test("a day with nothing to send says so", () => {
  const text = renderReminder({ date: today, wishes: [], later: [] });
  assert.equal(text, "🎉 *Today's wishes* · Wed 30 Sep\n\nNo wishes to send today.");
});

test("an anniversary counts years married, and has a default of its own", () => {
  assert.equal(occasionNote(couple, today), "25 years");
  assert.equal(occasionNote(anu, today), "turns 30");
  assert.equal(occasionNote({ ...couple, year: 2025 }, today), "1 year");
  assert.equal(occasionNote({ ...couple, year: null }, today), "");
  assert.match(renderWish(DEFAULT_ANNIVERSARY_TEMPLATE, { person: couple, date: today }), /^💍 Happy anniversary, \*Joseph & Mary\*! 🎉/);
  const text = renderReminder({ date: today, wishes: [{ time: "08:00", to: { label: "Youth" }, person: couple, text: "Happy {years}" }], later: [] });
  assert.match(text, /• \*08:00\* → Youth — 💍 Joseph & Mary \(25 years\)/);
});

test("{years} and {ordinal} fill in for both kinds; {age} and {ordinal_age} still work", () => {
  const template = "{ordinal} · {years} · {ordinal_age} · {age}";
  assert.equal(renderWish(template, { person: anu, date: today }), "30th · 30 · 30th · 30");
  assert.equal(renderWish(template, { person: couple, date: today }), "25th · 25 · 25th · 25");
});

test("an alert about several messages names each, with its own reason and tries left", () => {
  const reminder = { kind: "reminder", time: "07:00", to: { label: "the linked phone" }, person: null };
  const wish = { kind: "wish", time: "08:00", to: { label: "Choir" }, person: couple };
  const text = renderRefusedAlert({
    maxAttempts: 6,
    items: [
      { job: reminder, delivery: { attempts: 6, error: "WhatsApp did not take the message." } },
      { job: wish, delivery: { attempts: 5, error: "Only admins can send messages in this group." } },
    ],
  });
  assert.equal(
    text,
    [
      "⚠️ *Wish Calendar: 2 messages were not sent*",
      "",
      "🗓️ *Your morning reminder* → the linked phone · 07:00",
      "WhatsApp did not take the message.",
      "It won’t be tried again on its own.",
      "",
      "💍 *Joseph & Mary* → Choir · 08:00",
      "Only admins can send messages in this group.",
      "It is tried again every 10 minutes, 1 more time.",
      "",
      "To send them now: Wish Calendar → Today → Retry now.",
    ].join("\n"),
  );
  assert.equal(alertSummary(text), "2 messages were not sent");
  assert.equal(alertSummary(renderTestAlert()), "test alert");
  assert.equal(alertSummary("something else"), "an alert");
});

test("the morning alert lists days gone by, each day's wishes grouped by why", () => {
  const job = (person, label) => ({ kind: "wish", time: "08:00", to: { label }, person });
  const text = renderMissedAlert({
    days: [
      { date: { year: 2026, month: 9, day: 29 }, items: [{ job: job(anu, "Youth"), delivery: null }] },
      {
        date: today,
        items: [
          { job: job(biju, "Youth"), delivery: null },
          { job: job(couple, "Choir"), delivery: { status: "sending" } },
        ],
      },
    ],
  });
  assert.equal(
    text,
    [
      "⚠️ *Wish Calendar: 3 wishes were not sent*",
      "",
      "*Tue 29 Sep*",
      "🎂 *Anu Joseph* → Youth · 08:00",
      "Not tried before the day ended: this computer was off or asleep, or WhatsApp was not connected.",
      "",
      "*Wed 30 Sep*",
      "🎂 *Biju Thomas* → Youth · 08:00",
      "Not tried before the day ended: this computer was off or asleep, or WhatsApp was not connected.",
      "",
      "💍 *Joseph & Mary* → Choir · 08:00",
      "The app stopped while sending it, so it may not have gone out.",
      "",
      "To wish them late: Wish Calendar → People → Send now.",
    ].join("\n"),
  );
});
