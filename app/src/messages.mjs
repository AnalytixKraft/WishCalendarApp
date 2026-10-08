/* What the app sends: a wish for a birthday or an anniversary, from a
 * template, the daily reminder to the organiser, and the calendar's messages
 * to you — "Your day" each morning, and an event's reminder. WhatsApp
 * formatting applies: *bold*, _italic_, ~strike~. */

import { timeRange } from "./calendar.mjs";
import { addDays, ageOn, formatShortDate, fromIsoDate, isoDate, ordinal } from "./dates.mjs";

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

/* --------------------------------------------------------------- calendar */

/* "today", "tomorrow", or "Thu 15 Oct", seen from `date`. */
function dayWord(day, date) {
  if (day === isoDate(date)) return "today";
  if (day === isoDate(addDays(date, 1))) return "tomorrow";
  return formatShortDate(fromIsoDate(day));
}

/* One event in a list: its time (or all day), its title, and which of its
 * days this is when it lasts longer. */
function eventLine({ event, dayOf, days }) {
  const when = timeRange(event) ? `*${timeRange(event)}*` : "All day";
  return `• ${when} ${event.title}${days > 1 ? ` (day ${dayOf} of ${days})` : ""}`;
}

/* The morning's "Your day": what the calendar holds today, the tasks due
 * (and overdue), and tomorrow's events. Each list as eventsOn() makes it;
 * tasks as db.tasks.dueBy(). */
export function renderAgenda({ date, today, tasks, tomorrow }) {
  const day = isoDate(date);
  const lines = [`🗓️ *Your day* · ${formatShortDate(date)}`];
  lines.push("", ...(today.length ? today.map(eventLine) : ["Nothing on the calendar today."]));
  if (tasks.length) {
    lines.push("", "*To do*");
    for (const task of tasks) lines.push(`• ${task.title}${task.due < day ? ` — overdue since ${formatShortDate(fromIsoDate(task.due))}` : ""}`);
  }
  if (tomorrow.length) lines.push("", "*Tomorrow*", ...tomorrow.map(eventLine));
  return lines.join("\n");
}

/* An event's reminder, sent `remind` minutes before it starts — said by its
 * day and time, so it reads right even if it goes out late. */
export function renderEventReminder({ event, start, date }) {
  const when = dayWord(start, date);
  const lines = [`⏰ *${event.title}*`, `${when[0].toUpperCase()}${when.slice(1)}${timeRange(event) ? `, ${timeRange(event)}` : ", all day"}`];
  if (event.notes.trim()) lines.push(quoted(event.notes));
  return lines.join("\n");
}

/* ----------------------------------------------------------------- alerts */

/* When a wish is not sent, the app says so on WhatsApp: which, to where,
 * and why. An alert's first line is its title; the Today page shows it. */
const alertTitle = (what) => `⚠️ *Wish Calendar: ${what}*`;
const ALERT_TITLE = /^⚠️ \*Wish Calendar: (.+)\*$/;

/* "a wish was not sent", from an alert's text. */
export function alertSummary(text) {
  return ALERT_TITLE.exec(String(text ?? "").split("\n")[0])?.[1] ?? "an alert";
}

/* A message an alert is about: whose, to where, at what time. */
function alertLine(job) {
  const what = {
    reminder: "🗓️ *Your morning reminder*",
    agenda: "🗓️ *Your day*",
    event: `⏰ *${job.title}*`,
  }[job.kind] ?? `${KIND_ICON[job.person.kind] ?? "🎂"} *${job.person.name}*`;
  return `${what} → ${job.to.label} · ${job.time}`;
}

const ONE = { wish: "a wish", reminder: "your reminder", agenda: "“Your day”", event: "a calendar reminder" };

function notSent(items) {
  const wishes = items.filter((item) => item.job.kind === "wish").length;
  if (items.length === 1) return `${ONE[items[0].job.kind] ?? "a message"} was not sent`;
  return `${items.length} ${wishes === items.length ? "wishes" : "messages"} were not sent`;
}

/* Today's messages that WhatsApp refused. items: [{job, delivery}], each
 * delivery as the refusal left it — its tries, and the reason in words. */
export function renderRefusedAlert({ items, maxAttempts }) {
  const lines = [alertTitle(notSent(items))];
  for (const { job, delivery } of items) {
    const left = Math.max(0, maxAttempts - delivery.attempts);
    lines.push(
      "",
      alertLine(job),
      delivery.error,
      left ? `It is tried again every 10 minutes, ${left} more ${left === 1 ? "time" : "times"}.` : "It won’t be tried again on its own.",
    );
  }
  lines.push("", `To send ${items.length === 1 ? "it" : "them"} now: Wish Calendar → Today → Retry now.`);
  return lines.join("\n");
}

/* Why a wish of a day gone by was not sent, from its delivery row — none
 * when it was never tried. */
function missedReason(delivery) {
  if (!delivery) return "Not tried before the day ended: this computer was off or asleep, or WhatsApp was not connected.";
  if (delivery.status === "sending") return "The app stopped while sending it, so it may not have gone out.";
  return delivery.error || "WhatsApp did not take it.";
}

/* The wishes of days gone by that were not sent. days: [{date, items:
 * [{job, delivery}]}], oldest first. Wishes missed for the same reason are
 * listed together, and the reason said once. */
export function renderMissedAlert({ days }) {
  const items = days.flatMap((d) => d.items);
  const lines = [alertTitle(`${notSent(items)}${days.length === 1 ? ` on ${formatShortDate(days[0].date)}` : ""}`)];
  for (const day of days) {
    lines.push("");
    if (days.length > 1) lines.push(`*${formatShortDate(day.date)}*`);
    const byReason = new Map();
    for (const { job, delivery } of day.items) {
      const reason = missedReason(delivery);
      byReason.set(reason, [...(byReason.get(reason) ?? []), job]);
    }
    [...byReason].forEach(([reason, jobs], i) => lines.push(...(i ? [""] : []), ...jobs.map(alertLine), reason));
  }
  lines.push("", "To wish them late: Wish Calendar → People → Send now.");
  return lines.join("\n");
}

/* "Send a test alert" on the Settings page. */
export function renderTestAlert() {
  return [alertTitle("test alert"), "", "This is how an alert looks. When a wish can’t be sent, one like it comes here, saying which wish and why."].join("\n");
}
