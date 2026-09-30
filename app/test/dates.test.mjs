import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays,
  ageOn,
  isBirthdayOn,
  isValidDayMonth,
  nextBirthday,
  ordinal,
  parseTime,
  upcomingBirthdays,
  zonedNow,
} from "../src/dates.mjs";

const d = (year, month, day) => ({ year, month, day });

test("zonedNow reads the wall clock in the given time zone", () => {
  // 19:00 UTC on 30 Sep is 00:30 on 1 Oct in India.
  assert.deepEqual(zonedNow(new Date("2026-09-30T19:00:00Z"), "Asia/Kolkata"), { year: 2026, month: 10, day: 1, hour: 0, minute: 30 });
  assert.deepEqual(zonedNow(new Date("2026-09-30T19:00:00Z"), "UTC"), { year: 2026, month: 9, day: 30, hour: 19, minute: 0 });
  // Midnight is hour 0, never 24.
  assert.equal(zonedNow(new Date("2026-01-01T00:00:00Z"), "UTC").hour, 0);
});

test("29 February is celebrated on 28 February in a common year", () => {
  const leapling = { month: 2, day: 29 };
  assert.equal(isBirthdayOn(leapling, d(2027, 2, 28)), true);
  assert.equal(isBirthdayOn(leapling, d(2027, 3, 1)), false);
  assert.equal(isBirthdayOn(leapling, d(2028, 2, 29)), true);
  assert.equal(isBirthdayOn(leapling, d(2028, 2, 28)), false);
});

test("nextBirthday counts across the new year", () => {
  assert.deepEqual(nextBirthday({ month: 1, day: 2 }, d(2026, 12, 30)), { date: d(2027, 1, 2), inDays: 3 });
  assert.deepEqual(nextBirthday({ month: 9, day: 30 }, d(2026, 9, 30)), { date: d(2026, 9, 30), inDays: 0 });
  assert.equal(nextBirthday({ month: 9, day: 29 }, d(2026, 9, 30)).inDays, 364);
});

test("upcomingBirthdays lists today and the days ahead, soonest first", () => {
  const people = [
    { name: "Cara", month: 10, day: 2 },
    { name: "Anu", month: 9, day: 30 },
    { name: "Biju", month: 10, day: 1 },
    { name: "Dev", month: 10, day: 9 },
  ];
  const names = upcomingBirthdays(people, d(2026, 9, 30), 2).map((u) => u.person.name);
  assert.deepEqual(names, ["Anu", "Biju", "Cara"]);
  assert.deepEqual(upcomingBirthdays(people, d(2026, 9, 30), 0).map((u) => u.person.name), ["Anu"]);
});

test("ageOn needs a birth year before the date", () => {
  assert.equal(ageOn({ year: 1996 }, d(2026, 9, 30)), 30);
  assert.equal(ageOn({ year: null }, d(2026, 9, 30)), null);
  assert.equal(ageOn({ year: 2026 }, d(2026, 9, 30)), null);
});

test("ordinal", () => {
  const cases = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 11: "11th", 12: "12th", 13: "13th", 21: "21st", 22: "22nd", 23: "23rd", 101: "101st", 111: "111th", 112: "112th" };
  for (const [n, expected] of Object.entries(cases)) assert.equal(ordinal(Number(n)), expected);
});

test("parseTime takes HH:MM only", () => {
  assert.equal(parseTime("08:00"), 480);
  assert.equal(parseTime("23:59"), 1439);
  assert.equal(parseTime("00:00"), 0);
  for (const bad of ["24:00", "8:00", "08:60", "", null, "08:00:00"]) assert.equal(parseTime(bad), null);
});

test("isValidDayMonth allows 29 February, not 30", () => {
  assert.equal(isValidDayMonth(29, 2), true);
  assert.equal(isValidDayMonth(30, 2), false);
  assert.equal(isValidDayMonth(31, 4), false);
  assert.equal(isValidDayMonth(31, 12), true);
  assert.equal(isValidDayMonth(0, 1), false);
  assert.equal(isValidDayMonth(1, 13), false);
});

test("addDays crosses months and years", () => {
  assert.deepEqual(addDays(d(2026, 12, 31), 1), d(2027, 1, 1));
  assert.deepEqual(addDays(d(2028, 2, 28), 1), d(2028, 2, 29));
  assert.deepEqual(addDays(d(2026, 3, 1), -1), d(2026, 2, 28));
});
