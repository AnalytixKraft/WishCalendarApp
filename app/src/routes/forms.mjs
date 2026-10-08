/* Reading the fields more than one page has. */

import { addDays, fromIsoDate, isoDate, parseTime } from "../dates.mjs";
import { MAX_TEMPLATE } from "../messages.mjs";

export const GROUP_JID = /^\d+(-\d+)?@g\.us$/;

/* "Send to": '' (not chosen), 'direct' (the number beside it), a group — or,
 * for the reminder, 'self' (the linked phone). → {sendTo} or {error}. */
export function readSendTo(value, phone, { direct = "their", self = false } = {}) {
  if (value === "" || GROUP_JID.test(value) || (self && value === "self")) return { sendTo: value };
  if (value === "direct") {
    return phone ? { sendTo: "direct" } : { error: `Add ${direct} WhatsApp number first — or choose a group.` };
  }
  return { error: "Choose where the wish goes." };
}

export const readMessage = (form, name) => form.raw(name).replace(/\r\n/g, "\n").trim().slice(0, MAX_TEMPLATE);

/* A person's own send time: '' (the wish time in Settings) or HH:MM. */
export function readTime(value) {
  return value === "" || parseTime(value) !== null ? { time: value } : { error: "Enter a time like 09:30, or leave it empty." };
}

/* 'YYYY-MM-DD' that is a real day → {year, month, day}; else null. */
export function readDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = fromIsoDate(value);
  return date.year >= 1900 && date.year <= 2100 && isoDate(addDays(date, 0)) === value ? date : null;
}
