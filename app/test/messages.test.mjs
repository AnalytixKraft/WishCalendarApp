import assert from "node:assert/strict";
import { test } from "node:test";
import { upcomingBirthdays } from "../src/dates.mjs";
import { DEFAULT_TEMPLATE, renderReminder, renderWish } from "../src/messages.mjs";

const today = { year: 2026, month: 9, day: 30 };
const anu = { id: 1, name: "Anu Joseph", day: 30, month: 9, year: 1996 };
const biju = { id: 2, name: "Biju Thomas", day: 30, month: 9, year: null };

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

test("the reminder lists today with its groups, then what is coming up", () => {
  const people = [anu, biju, { id: 3, name: "Mary K", day: 1, month: 10, year: 1981 }, { id: 4, name: "Jose P", day: 3, month: 10, year: null }];
  const text = renderReminder({
    date: today,
    entries: upcomingBirthdays(people, today, 3),
    wishGroups: new Map([[1, ["St. Mary's Youth"]], [2, []]]),
    wishTime: "08:00",
  });
  assert.equal(
    text,
    [
      "🎂 *Birthday reminder* · Wed 30 Sep",
      "",
      "*Today*",
      "• Anu Joseph — turns 30",
      "   wished at 08:00 in St. Mary's Youth",
      "• Biju Thomas",
      "",
      "*Coming up*",
      "• Tomorrow — Mary K (turns 45)",
      "• Sat 3 Oct — Jose P",
    ].join("\n"),
  );
});
