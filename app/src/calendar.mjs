/* The calendar's rules: what an event can repeat as, the reminders it can
 * have, and which days it falls on. Days are 'YYYY-MM-DD' strings here — the
 * way the database keeps them, and they sort as dates do. */

import { celebrationDate, daysInMonth, fromIsoDate, isoDate } from "./dates.mjs";

export const MAX_TITLE = 200;
export const MAX_NOTES = 5_000;

export const REPEATS = [
  ["", "Does not repeat"],
  ["daily", "Every day"],
  ["weekly", "Every week"],
  ["monthly", "Every month"],
  ["yearly", "Every year"],
];

/* Minutes before the event starts. An all-day event has only the ones a day
 * or more ahead: on the day itself it is in "Your day" already. */
export const REMINDERS = [
  [0, "At the time"],
  [5, "5 minutes before"],
  [10, "10 minutes before"],
  [30, "30 minutes before"],
  [60, "1 hour before"],
  [120, "2 hours before"],
  [1440, "1 day before"],
  [2880, "2 days before"],
  [10080, "1 week before"],
];
export const DAY_MINUTES = 1440;
export const reminderLabel = (minutes) => REMINDERS.find(([m]) => m === minutes)?.[1] ?? `${minutes} minutes before`;
export const repeatLabel = (repeat) => REPEATS.find(([r]) => r === repeat)?.[1] ?? "";

const DAY_MS = 86_400_000;
const serial = (day) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
const fromSerial = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/* The day `n` days after `day` (before, for a negative n). */
export const shiftDay = (day, n) => fromSerial(serial(day) + n);
export const daysBetween = (from, to) => serial(to) - serial(from);

/* How many days an event lasts after the day it starts: 0 for one day. */
export const spanOf = (event) => (event.endDay ? daysBetween(event.day, event.endDay) : 0);

/* The days an event starts on, from `from` through `to`, in order. A monthly
 * event on the 31st falls on the last day of a shorter month, and a yearly
 * one on 29 February on the 28th in a common year — as birthdays do. */
export function startsBetween(event, from, to) {
  const last = event.repeat && event.repeatUntil && event.repeatUntil < to ? event.repeatUntil : to;
  const first = event.day > from ? event.day : from;
  if (first > last) return [];
  const out = [];
  const keep = (day) => {
    if (day >= first && day <= last) out.push(day);
  };
  const start = fromIsoDate(event.day);
  switch (event.repeat) {
    case "daily":
      for (let day = first; day <= last; day = shiftDay(day, 1)) out.push(day);
      break;
    case "weekly": {
      const behind = daysBetween(event.day, first);
      for (let day = shiftDay(event.day, Math.ceil(behind / 7) * 7); day <= last; day = shiftDay(day, 7)) out.push(day);
      break;
    }
    case "monthly": {
      let { year, month } = fromIsoDate(first);
      for (;;) {
        const day = isoDate({ year, month, day: Math.min(start.day, daysInMonth(year, month)) });
        if (day > last) break;
        keep(day);
        if (month === 12) {
          month = 1;
          year++;
        } else {
          month++;
        }
      }
      break;
    }
    case "yearly":
      for (let year = fromIsoDate(first).year; year <= fromIsoDate(last).year; year++) keep(isoDate(celebrationDate(start, year)));
      break;
    default:
      keep(event.day);
  }
  return out;
}

/* The event's occurrences that touch any day from `from` through `to`:
 * [{start, end}] — the same day for a one-day event. */
export function occurrencesBetween(event, from, to) {
  const span = spanOf(event);
  return startsBetween(event, shiftDay(from, -span), to).map((start) => ({ start, end: shiftDay(start, span) }));
}

/* "09:00–10:30", "09:00", or "" for an all-day event. */
export const timeRange = (event) => (event.time ? `${event.time}${event.endTime ? `–${event.endTime}` : ""}` : "");

/* An event's place in a day's list: all-day first, then by time. */
export const byTime = (a, b) => (a.event.time || "").localeCompare(b.event.time || "") || a.event.title.localeCompare(b.event.title);

/* What a day holds of the calendar: its events — with which of their days
 * this is, for one that lasts longer — and the tasks due on it. */
export function eventsOn(events, day) {
  return events
    .flatMap((event) =>
      occurrencesBetween(event, day, day).map(({ start, end }) => ({
        event,
        start,
        dayOf: daysBetween(start, day) + 1,
        days: daysBetween(start, end) + 1,
      })),
    )
    .sort(byTime);
}
