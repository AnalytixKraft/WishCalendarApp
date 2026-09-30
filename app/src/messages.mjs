/* What the app sends: a wish for a birthday or an anniversary, from a
 * template, and the daily reminder to the organiser. WhatsApp formatting
 * applies: *bold*, _italic_, ~strike~. */

import { ageOn, formatShortDate, ordinal } from "./dates.mjs";

/* The occasions a row on the People page can be. */
export const KINDS = ["birthday", "anniversary"];
export const KIND_ICON = { birthday: "🎂", anniversary: "💍" };
export const KIND_LABEL = { birthday: "Birthday", anniversary: "Anniversary" };

export const DEFAULT_TEMPLATE = [
  "🎉 Happy birthday, *{name}*! 🎂",
  "",
  "Wishing you a wonderful year ahead, full of joy, good health and blessings. Have a lovely day! 🥳",
].join("\n");

export const DEFAULT_ANNIVERSARY_TEMPLATE = [
  "💍 Happy anniversary, *{name}*! 🎉",
  "",
  "Wishing you many more years of love, joy and blessings together. Have a wonderful day! 💐",
].join("\n");

/* The default message for a kind of occasion, as Settings has it. */
export const defaultTemplateFor = (kind, settings) => (kind === "anniversary" ? settings.anniversaryTemplate : settings.template);

/* "turns 30" for a birthday, "25 years" for an anniversary — or "" when the
 * year is not known. */
export function occasionNote(person, date) {
  const years = ageOn(person, date);
  if (!years) return "";
  return person.kind === "anniversary" ? `${years} ${years === 1 ? "year" : "years"}` : `turns ${years}`;
}

/* What each placeholder becomes, as the pages explain it. {age} and
 * {ordinal_age} are the older names of {years} and {ordinal}; both work. */
export const PLACEHOLDERS = [
  ["{name}", "their name — or the couple's — as it is on the list"],
  ["{first_name}", "the first word of the name"],
  ["{years}", "the age they turn, or the years married — left out when the year is not known"],
  ["{ordinal}", "the same as 30th, 25th… — left out when not known"],
  ["{group}", "the group's name — left out when the wish goes to their number"],
];
const PLACEHOLDER = /\{(name|first_name|years|ordinal|age|ordinal_age|group)\}/g;

export const MAX_TEMPLATE = 2_000;


export function renderWish(template, { person, date, groupName = "" }) {
  const years = ageOn(person, date);
  const values = {
    name: person.name,
    first_name: person.name.trim().split(/\s+/)[0],
    years: years ? String(years) : "",
    ordinal: years ? ordinal(years) : "",
    age: years ? String(years) : "",
    ordinal_age: years ? ordinal(years) : "",
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

/* The organiser's morning note: every wish the day holds — at
 * what time, to where, and what it says — then the birthdays coming up.
 *   wishes  today's wish jobs, in the order they go out ({time, to, person,
 *           text, sent}); to is null for someone with no "Send to"
 *   later   upcomingBirthdays() after today */
export function renderReminder({ date, wishes, later }) {
  const lines = [`🎉 *Today's wishes* · ${formatShortDate(date)}`];
  if (!wishes.length) lines.push("", "No wishes to send today.");
  for (const wish of wishes) {
    const note = occasionNote(wish.person, date);
    const who = `${KIND_ICON[wish.person.kind] ?? "🎂"} ${wish.person.name}${note ? ` (${note})` : ""}`;
    lines.push("");
    if (!wish.to) {
      lines.push(`⚠️ ${who} — no “Send to” chosen, so nothing will be sent`);
      continue;
    }
    lines.push(`${wish.sent ? "✓" : "•"} *${wish.time}* → ${wish.to.label} — ${who}${wish.sent ? " · sent" : ""}`);
    lines.push(quoted(wish.text));
  }
  if (later.length) {
    lines.push("", "*Coming up*");
    for (const { person, date: day, inDays } of later) {
      const note = occasionNote(person, day);
      lines.push(`• ${inDays === 1 ? "Tomorrow" : formatShortDate(day)} — ${KIND_ICON[person.kind] ?? "🎂"} ${person.name}${note ? ` (${note})` : ""}`);
    }
  }
  return lines.join("\n");
}

/* A message inside the note, as a WhatsApp quote ("> "), cut short if long. */
function quoted(text) {
  const short = text.length > 240 ? `${text.slice(0, 239).trimEnd()}…` : text;
  return short
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => `> ${line}`)
    .join("\n");
}
