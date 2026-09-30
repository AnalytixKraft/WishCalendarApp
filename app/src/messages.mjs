/* What the app posts: a birthday wish into a group, from a template, and the
 * daily reminder to the organiser. WhatsApp formatting applies: *bold*,
 * _italic_, ~strike~. */

import { ageOn, formatShortDate, ordinal } from "./dates.mjs";

export const DEFAULT_TEMPLATE = [
  "🎉 Happy birthday, *{name}*! 🎂",
  "",
  "Wishing you a wonderful year ahead, full of joy, good health and blessings. Have a lovely day! 🥳",
].join("\n");

/* What each placeholder becomes, as the Groups and Settings pages explain it. */
export const PLACEHOLDERS = [
  ["{name}", "their name, as it is on the list"],
  ["{first_name}", "the first word of their name"],
  ["{age}", "the age they turn — left out when the birth year is not known"],
  ["{ordinal_age}", "the same as 30th, 41st… — left out when not known"],
  ["{group}", "the group's name"],
];
const PLACEHOLDER = /\{(name|first_name|age|ordinal_age|group)\}/g;

export const MAX_TEMPLATE = 2_000;

export const TEST_MESSAGE = "✅ Birthday Reminder can post in this group.";

export function renderWish(template, { person, date, groupName = "" }) {
  const age = ageOn(person, date);
  const values = {
    name: person.name,
    first_name: person.name.trim().split(/\s+/)[0],
    age: age ? String(age) : "",
    ordinal_age: age ? ordinal(age) : "",
    group: groupName,
  };
  return tidy(template.replace(PLACEHOLDER, (_, key) => values[key]));
}

/* A placeholder left out ("Happy {ordinal_age} birthday" with no birth year)
 * leaves two spaces, or a space before punctuation, behind it. */
function tidy(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/(\S) {2,}/g, "$1 ").replace(/(\S) +([,.!?])/g, "$1$2").trimEnd())
    .join("\n")
    .trim();
}

/* The organiser's note for the day: today's birthdays, with the groups their
 * wishes go to, then the ones coming up.
 *   entries     upcomingBirthdays(), today's included
 *   wishGroups  person id → names of the groups that will wish them today */
export function renderReminder({ date, entries, wishGroups, wishTime }) {
  const today = entries.filter((e) => e.inDays === 0);
  const later = entries.filter((e) => e.inDays > 0);
  const lines = [`🎂 *Birthday reminder* · ${formatShortDate(date)}`];
  if (today.length) {
    lines.push("", "*Today*");
    for (const { person, date: day } of today) {
      const age = ageOn(person, day);
      lines.push(`• ${person.name}${age ? ` — turns ${age}` : ""}`);
      const groups = wishGroups.get(person.id) || [];
      if (groups.length) lines.push(`   wished at ${wishTime} in ${groups.join(", ")}`);
    }
  }
  if (later.length) {
    lines.push("", "*Coming up*");
    for (const { person, date: day, inDays } of later) {
      const age = ageOn(person, day);
      lines.push(`• ${inDays === 1 ? "Tomorrow" : formatShortDate(day)} — ${person.name}${age ? ` (turns ${age})` : ""}`);
    }
  }
  return lines.join("\n");
}
