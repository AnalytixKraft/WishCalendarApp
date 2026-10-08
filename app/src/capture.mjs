/* 📅 messages: what is sent on WhatsApp to put on the calendar. The bridge
 * holds each message that starts with 📅 or 📆 in a chat chosen in Settings
 * → Calendar — a group, where anyone in it may send one, or Message yourself
 * (whatsapp/src/commands.mjs). This tells the bridge which chats those are,
 * takes the messages, turns each into an event or a task by simple rules,
 * and answers where calendar messages go.
 *
 *   📅 Dentist Tue 10am              an event, the coming Tuesday at 10:00
 *   📅 Trip to Munnar 10-13 Oct      an event, 10 to 13 October, all day
 *   📅 Call Mum 6:30pm               an event, that day at 18:30 (the next,
 *                                    when 18:30 had passed)
 *   📅 task Pay rent by Fri          a task, due Friday
 *   📅 Buy batteries                 a task: no day, no time
 *   a reply of 📅 to "Choir moves to Sat 6pm"
 *                                    an event "Choir moves", Saturday 18:00
 *
 * Days and times are read from the day the message was sent, in the app's
 * time zone — not the moment it is read, which can be hours later when this
 * computer was asleep. A timed event gets the reminder Settings gives new
 * events (5 minutes before, unless changed). The answer goes through the
 * scheduler (sendCalendarReply).
 *
 * Each message is taken once (db.captures, by WhatsApp's id), then the
 * bridge is told to let it go. Switched off in Settings, they are let go
 * unread. */

import { DAY_MINUTES, MAX_TITLE, reminderLabel, shiftDay, timeRange } from "./calendar.mjs";
import { daysInMonth, formatShortDate, fromIsoDate, isoDate, weekdayOf, zonedNow } from "./dates.mjs";

const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const MONTH_NUMBER = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAY = "(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)";
const WEEKDAY_NUMBER = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ORD = "(?:st|nd|rd|th)?";
/* Words before a day that belong to it, and go with it from the title. */
const LEAD = "((?:(?:on|from|by|due|this|next|coming)\\s+)*)";
const TO = "\\s*(?:-|–|—|to|till|until)\\s*";
const MERIDIEM = "(am|pm|a\\.m\\.|p\\.m\\.)";

const monthOf = (name) => MONTH_NUMBER[name.slice(0, 3).toLowerCase()];
const pad = (n) => String(n).padStart(2, "0");

/* A day and month, of `year` if given — else the next time it comes, from
 * `today` on (29 February: the next leap year). Null when there is no such
 * day. */
function dayOf(day, month, year, today) {
  const fits = (y) => month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(y, month);
  if (year) {
    const y = Number(year) < 100 ? Number(year) + 2000 : Number(year);
    return fits(y) ? isoDate({ year: y, month, day }) : null;
  }
  for (let y = today.year; y <= today.year + 8; y++) {
    if (fits(y) && isoDate({ year: y, month, day }) >= isoDate(today)) return isoDate({ year: y, month, day });
  }
  return null;
}

/* The ways a day can be written, most particular first. Each → {day,
 * endDay} or null. */
const DAYS = [
  // 30 Dec - 2 Jan, 28 Oct to 3 November 2026
  [new RegExp(`\\b${LEAD}(\\d{1,2})${ORD}\\s+${MONTH}(?:\\s+(\\d{4}))?${TO}(\\d{1,2})${ORD}\\s+${MONTH}(?:,?\\s+(\\d{4}))?\\b`, "i"), (m, today) => {
    const start = dayOf(Number(m[2]), monthOf(m[3]), m[4], today);
    const end = start && dayOf(Number(m[5]), monthOf(m[6]), m[7], fromIsoDate(start));
    return start && end && end > start ? { day: start, endDay: end } : null;
  }],
  // 10-13 Oct, 10th to 13th October
  [new RegExp(`\\b${LEAD}(\\d{1,2})${ORD}${TO}(\\d{1,2})${ORD}\\s+${MONTH}(?:,?\\s+(\\d{4}))?\\b`, "i"), (m, today) => {
    const start = dayOf(Number(m[2]), monthOf(m[4]), m[5], today);
    const end = start && dayOf(Number(m[3]), monthOf(m[4]), m[5] ?? start.slice(0, 4), today);
    return start && end && end > start ? { day: start, endDay: end } : null;
  }],
  // 2026-10-15
  [/\b((?:(?:on|from|by|due)\s+)*)(\d{4})-(\d{1,2})-(\d{1,2})\b/i, (m, today) => ({ day: dayOf(Number(m[4]), Number(m[3]), m[2], today) })],
  // 15 Oct, 15th of October 2026
  [new RegExp(`\\b${LEAD}(\\d{1,2})${ORD}(?:\\s+of)?\\s+${MONTH}(?:,?\\s+(\\d{4}))?\\b`, "i"), (m, today) => ({ day: dayOf(Number(m[2]), monthOf(m[3]), m[4], today) })],
  // Oct 15, October 15th 2026
  [new RegExp(`\\b${LEAD}${MONTH}\\s+(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?\\b`, "i"), (m, today) => ({ day: dayOf(Number(m[3]), monthOf(m[2]), m[4], today) })],
  // 15/10, 15/10/2026, 15-10-2026, 15.10.26 — the day first
  [/\b((?:(?:on|from|by|due)\s+)*)(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b|\b((?:(?:on|from|by|due)\s+)*)(\d{1,2})[-.](\d{1,2})[-.](\d{2}|\d{4})\b/i, (m, today) =>
    m[2] ? { day: dayOf(Number(m[2]), Number(m[3]), m[4], today), lead: m[1] } : { day: dayOf(Number(m[6]), Number(m[7]), m[8], today), lead: m[5] }],
  // today, tonight, tomorrow, day after tomorrow
  [/\b((?:(?:by|due)\s+)*)(day after tomorrow|today|tonight|tomorrow|tmrw|tmw)\b/i, (m, today) => ({
    day: shiftDay(isoDate(today), { today: 0, tonight: 0, tomorrow: 1, tmrw: 1, tmw: 1, "day after tomorrow": 2 }[m[2].toLowerCase()]),
  })],
  // Tue, next Friday — the coming one: today, if it is that day, unless "next"
  [new RegExp(`\\b${LEAD}${WEEKDAY}\\b`, "i"), (m, today) => {
    const ahead = (WEEKDAY_NUMBER[m[2].slice(0, 3).toLowerCase()] - weekdayOf(today) + 7) % 7;
    return { day: shiftDay(isoDate(today), ahead === 0 && /\bnext\b/i.test(m[1]) ? 7 : ahead) };
  }],
];

/* "6pm", "6:30 pm", "18:30" → 'HH:MM'; null when it is no time. */
function clock(h, m, meridiem) {
  let hour = Number(h);
  const minute = Number(m ?? 0);
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const pm = meridiem.toLowerCase().startsWith("p");
    if (pm && hour !== 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  return hour <= 23 && minute <= 59 ? `${pad(hour)}:${pad(minute)}` : null;
}

const AT = "((?:(?:at|from|@)\\s*)?)";
const TIMES = [
  // 6-8pm, 10:30am to 12pm, 11-1pm (11am to 1pm)
  [new RegExp(`\\b${AT}(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MERIDIEM}?${TO}(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MERIDIEM}(?!\\w)`, "i"), (m) => {
    const end = clock(m[5], m[6], m[7]);
    let start = clock(m[2], m[3], m[4] ?? m[7]);
    if (!m[4] && start && end && start >= end) start = clock(m[2], m[3], "am");
    return start && end && end > start ? { time: start, endTime: end } : null;
  }],
  // 10:00-10:45, 18:30 to 20:00
  [/\b((?:(?:at|from|@)\s*)?)([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|–|—|to|till|until)\s*([01]?\d|2[0-3]):([0-5]\d)\b/i, (m) => {
    const start = clock(m[2], m[3]);
    const end = clock(m[4], m[5]);
    return end > start ? { time: start, endTime: end } : null;
  }],
  // 6pm, 6.30 pm, 10am
  [new RegExp(`\\b${AT}(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MERIDIEM}(?!\\w)`, "i"), (m) => ({ time: clock(m[2], m[3], m[4]) })],
  // 18:30
  [/\b((?:(?:at|from|@)\s*)?)([01]?\d|2[0-3]):([0-5]\d)\b/i, (m) => ({ time: clock(m[2], m[3]) })],
  // noon
  [/\b((?:(?:at|from|@)\s*)?)(noon|midday)\b/i, () => ({ time: "12:00" })],
];

/* The first way of writing `ways` that matches, and the text without it. */
function find(text, ways, today) {
  for (const [pattern, read] of ways) {
    const m = pattern.exec(text);
    if (!m) continue;
    const found = read(m, today);
    if (!found || Object.values(found).some((v) => v === null)) continue;
    const lead = found.lead ?? m[1] ?? "";
    return { found, lead, rest: `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}` };
  }
  return { found: null, lead: "", rest: text };
}

const EDGE_WORDS = "on|at|from|by|due|to|for|this|next|coming|and|till|until";
const LEADING = new RegExp(`^(?:(?:${EDGE_WORDS})\\b|[-–—:,;@.])\\s*`, "i");
const TRAILING = new RegExp(`\\s*(?:\\b(?:${EDGE_WORDS})|[-–—:,;@.])$`, "i");

/* What is left once the day and time are out: the title, without the
 * little words that went with them. */
function tidy(text) {
  let t = text.replace(/\s+/g, " ").trim();
  for (let before = ""; before !== t; ) {
    before = t;
    t = t.replace(LEADING, "").replace(TRAILING, "").trim();
  }
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1).trimEnd()}…` : t;
}

/* A day and a time out of some text, and the text that is left. */
function scan(text, today) {
  const day = find(text, DAYS, today);
  const time = find(day.rest, TIMES, today);
  return { ...day.found, ...time.found, by: /\b(?:by|due)\b/i.test(day.lead), rest: time.rest };
}

const TASK = /^(?:task|todo|to-do|to do)\b[\s:–-]*/i;

/* A 📅 message → what it puts on the calendar:
 *   {kind: 'event', title, day, endDay, time, endTime, notes, why}
 *   {kind: 'task', title, due, notes, why}
 * `where`: the group's name, or null for Message yourself. */
export function readCapture({ text, quoted, sent_at: sentAt, sender = null }, { timeZone, where = null }) {
  const now = zonedNow(new Date(sentAt), timeZone);
  const today = { year: now.year, month: now.month, day: now.day };
  const asTask = TASK.test(text);
  const own = scan(text.replace(TASK, ""), today);
  const theirs = quoted ? scan(quoted, today) : null;
  const firstLine = (s) => s.split("\n").map((line) => line.trim()).find(Boolean) ?? "";

  const day = own.day ? own : theirs?.day ? theirs : null;
  const time = own.time ? own : theirs?.time ? theirs : null;
  const title = tidy(own.rest) || (theirs ? tidy(firstLine(theirs.rest)) || tidy(firstLine(quoted)) : "") || "Untitled";
  const notes = [quoted, `From WhatsApp: ${where ?? "Message yourself"}${sender ? `, ${sender}` : ""}`].filter(Boolean).join("\n\n");

  if (asTask || (day && !time && (own.by || (!own.day && theirs?.by))) || (!day && !time)) {
    return {
      kind: "task",
      title,
      due: day?.day ?? null,
      notes,
      sender,
      why: asTask || day ? null : "There was no day or time in it, so it is a task.",
    };
  }
  let on = day?.day ?? isoDate(today);
  // A time and no day: that day, or the next when the time had passed.
  if (!day && time.time <= `${pad(now.hour)}:${pad(now.minute)}`) on = shiftDay(on, 1);
  return { kind: "event", title, day: on, endDay: day?.endDay ?? null, time: time?.time ?? "", endTime: time?.endTime ?? "", notes, sender, why: null };
}

/* The answer, where calendar messages go: what was added, and when — and
 * from whom, when someone in a group sent it. Never starts with 📅 or 📆,
 * so it can never be taken for one. */
export function renderCaptureReply(item) {
  const short = (day) => formatShortDate(fromIsoDate(day));
  const by = item.sender ? ` (from ${item.sender})` : "";
  if (item.kind === "event") {
    const days = item.endDay ? `${short(item.day)} – ${short(item.endDay)}` : short(item.day);
    const when = `${days}, ${timeRange(item) || "all day"}`;
    const reminder = item.remind === null || item.remind === undefined ? [] : [`Reminder ${reminderLabel(item.remind).toLowerCase()}.`];
    return [`✅ Added to the calendar: *${item.title}*${by}`, when, ...reminder, "", "Not right? Change it in Wish Calendar → Calendar."].join("\n");
  }
  return [
    `✅ Added a task: *${item.title}*${item.due ? ` — due ${short(item.due)}` : ""}${by}`,
    ...(item.why ? [item.why] : []),
    "",
    "Not right? Change it in Wish Calendar → Calendar.",
  ].join("\n");
}

/* The reminder a new event gets, as Settings says — when it can have it: an
 * all-day event only one a day or more ahead. */
export function reminderFor(event, minutes) {
  if (minutes === null || minutes === undefined) return null;
  return event.time || minutes >= DAY_MINUTES ? minutes : null;
}

export const POLL_MS = 15_000;
const KEEP_DAYS = 31;

export function createCapture({ db, bridge, scheduler, log, clock = () => new Date() }) {
  let busy = false;
  let timer = null;
  let lastProblem = null;

  /* Where a 📅 message was sent, by name: a group as WhatsApp last listed
   * it, or null for Message yourself. */
  const whereOf = (command) => (command.chat === "group" ? db.chats.names().get(command.chat_id) || "a group" : null);

  /* The chats 📅 messages count in now: none while switched off. */
  const chosen = (settings) => (settings.capture ? [...new Set(settings.captureChats)].sort() : []);
  const keyOf = (command) => (command.chat === "self" ? "self" : command.chat_id);

  /* Puts one 📅 message on the calendar. → what it became, or null. */
  function take(command, settings) {
    if (!chosen(settings).includes(keyOf(command))) {
      // Held by the bridge before the chat was let go of: not added.
      db.captures.record(command);
      return null;
    }
    const read = readCapture(command, { timeZone: settings.timezone, where: whereOf(command) });
    const item = read.kind === "event" ? { ...read, remind: reminderFor(read, settings.defaultRemind) } : read;
    return db.transaction(() => {
      const id =
        item.kind === "event"
          ? db.events.create({ title: item.title, day: item.day, endDay: item.endDay, time: item.time, endTime: item.endTime, remind: item.remind, notes: item.notes })
          : db.tasks.create({ title: item.title, due: item.due, notes: item.notes });
      db.captures.record(command, item.kind, id);
      return item;
    });
  }

  /* The bridge acts on the chats it was last told of — none after it
   * starts. Told again whenever that is not what Settings says. */
  async function tellChats(has, settings) {
    const wanted = chosen(settings);
    if (!Array.isArray(has) || [...has].sort().join(" ") === wanted.join(" ")) return;
    await bridge.setCommandChats(wanted);
    log.info({ self: wanted.includes("self"), groups: wanted.filter((c) => c !== "self").length }, "📅 messages: told the bridge where they count");
  }

  /* Takes what the bridge holds, answers each, and tells it to let them go.
   * → how many were put on the calendar */
  async function poll() {
    if (busy) return 0;
    busy = true;
    try {
      let commands;
      const settings = db.settings.get();
      try {
        const held = await bridge.commands();
        commands = held.commands ?? [];
        await tellChats(held.chats, settings);
      } catch (err) {
        // Not linked, not running, or a bridge from before 📅 messages: the
        // next poll asks again. Said once, not every 15 s.
        if (err.code !== lastProblem) log.info({ code: err.code }, "📅 messages: the bridge has none to give");
        lastProblem = err.code;
        return 0;
      }
      lastProblem = null;
      if (!commands.length) return 0;
      let added = 0;
      const taken = [];
      for (const command of [...commands].sort((a, b) => a.sent_at.localeCompare(b.sent_at))) {
        if (!db.captures.has(command.id)) {
          const item = take(command, settings);
          if (item) {
            added++;
            log.info({ message_id: command.id, kind: item.kind }, "📅 message put on the calendar"); // never its text
            try {
              await scheduler.sendCalendarReply({ key: `capture:${command.id}`, title: item.title, text: renderCaptureReply(item) });
            } catch (err) {
              log.warn({ message_id: command.id, err: err.message }, "📅 message added, but its answer was not sent");
            }
          }
        }
        taken.push(command.id);
      }
      await bridge.ackCommands(taken).catch((err) => log.warn({ code: err.code }, "📅 messages: the bridge was not told; they are taken once all the same"));
      db.captures.prune(new Date(clock().getTime() - KEEP_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"));
      return added;
    } finally {
      busy = false;
    }
  }

  return {
    poll,
    start() {
      const tick = () => poll().catch((err) => log.error({ err: err?.stack || String(err) }, "📅 messages: a poll failed"));
      timer = setInterval(tick, POLL_MS);
    },
    stop: () => clearInterval(timer),
  };
}
