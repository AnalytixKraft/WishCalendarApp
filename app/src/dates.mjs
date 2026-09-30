/* Calendar arithmetic for birthdays, on plain {year, month, day} values —
 * never on Date objects in local time, whose meaning depends on the
 * container's TZ. "Today" is always read in the time zone set on the
 * Settings page (zonedNow). */

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n) => String(n).padStart(2, "0");
const DAY_MS = 86_400_000;

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/* A birthday is a day and a month. 29 February is allowed: it is celebrated
 * every year (celebrationDate says on which day). */
export function isValidDayMonth(day, month) {
  return (
    Number.isInteger(day) &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(2000, month)
  );
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/* The wall-clock date and time in `timeZone` at the instant `at`. */
export function zonedNow(at, timeZone) {
  const parts = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  for (const { type, value } of format.formatToParts(at)) parts[type] = value;
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute };
}

export const isoDate = ({ year, month, day }) => `${year}-${pad(month)}-${pad(day)}`;

/* "2026-09-30" → {year, month, day}: isoDate the other way. */
export function fromIsoDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

export function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export const weekdayOf = ({ year, month, day }) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();

const serial = ({ year, month, day }) => Date.UTC(year, month - 1, day) / DAY_MS;

/* The day a birthday is celebrated in `year`: 29 February falls on
 * 28 February in a common year. */
export function celebrationDate(person, year) {
  if (person.month === 2 && person.day === 29 && !isLeapYear(year)) return { year, month: 2, day: 28 };
  return { year, month: person.month, day: person.day };
}

export function isBirthdayOn(person, date) {
  const c = celebrationDate(person, date.year);
  return c.month === date.month && c.day === date.day;
}

/* The next celebration on or after `from`: its date, and how many days away. */
export function nextBirthday(person, from) {
  let date = celebrationDate(person, from.year);
  if (serial(date) < serial(from)) date = celebrationDate(person, from.year + 1);
  return { date, inDays: serial(date) - serial(from) };
}

/* The celebration nearest `from`, before or after it — for a wish sent on
 * another day than the birthday: early, or late. inDays is negative for one
 * that has passed. */
export function nearestBirthday(person, from) {
  const next = nextBirthday(person, from);
  const previous = celebrationDate(person, next.date.year - 1);
  const back = serial(from) - serial(previous);
  return back < next.inDays ? { date: previous, inDays: -back } : next;
}

/* The age a person turns on `date`, their celebration day — or null when the
 * birth year is not known (or is not before `date`). */
export function ageOn(person, date) {
  if (!person.year) return null;
  const age = date.year - person.year;
  return age > 0 ? age : null;
}

/* Everyone whose next birthday is at most `days` days after `from` (0 means
 * today only), soonest first. */
export function upcomingBirthdays(people, from, days) {
  return people
    .map((person) => ({ person, ...nextBirthday(person, from) }))
    .filter((b) => b.inDays <= days)
    .sort((a, b) => a.inDays - b.inDays || a.person.name.localeCompare(b.person.name));
}

export function ordinal(n) {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
}

/* "07:30" → minutes since midnight; anything else → null. */
export function parseTime(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export const shortMonth = (month) => MONTHS[month - 1].slice(0, 3);
export const shortWeekday = (date) => WEEKDAYS[weekdayOf(date)].slice(0, 3);
export const formatDayMonth = ({ day, month }) => `${day} ${shortMonth(month)}`;
export const formatShortDate = (date) => `${shortWeekday(date)} ${date.day} ${shortMonth(date.month)}`;
export const formatBirthday = (person) => `${person.day} ${MONTHS[person.month - 1]}${person.year ? ` ${person.year}` : ""}`;
