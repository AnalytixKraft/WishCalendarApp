/* The clock. Twice a minute it works out what today's messages are — for
 * birthdays and anniversaries alike — and sends the ones that are due and
 * not yet sent:
 *
 *   - the reminder, at the reminder time, to where Settings says (the linked
 *     phone, your number, or a group): every birthday message the day holds,
 *     and the birthdays of the next few days;
 *   - a wish for each birthday or anniversary that falls today, at its own
 *     time (or the wish time in Settings), to where its row on the People
 *     page says: a group, or their number.
 *
 * Each message has a key — reminder:<day>, wish:<day>:<person> — and a
 * message whose key is marked sent is never sent again: not on the next
 * tick, not after a restart, not when someone presses Send now. If the
 * computer was asleep or off at the set time, the day's messages go out when
 * it is back, the same day. A day's messages are never sent on a later day.
 *
 * WhatsApp not being connected is not a failed message: nothing is attempted
 * (and no retry is used up) until the bridge says `open`. A message that
 * WhatsApp refuses is retried every 10 minutes, at most 6 times a day. */

import { BridgeError, CONNECTION_CODES, explain } from "./bridge.mjs";
import {
  addDays,
  formatShortDate,
  isBirthdayOn,
  isoDate,
  nearestBirthday,
  nextBirthday,
  parseTime,
  upcomingBirthdays,
  zonedNow,
} from "./dates.mjs";
import { defaultTemplateFor, renderReminder, renderWish } from "./messages.mjs";
import { directJid, formatPhone, phoneOfJid } from "./phone.mjs";

/* A send the person asked for that cannot happen, in words for them. */
export class NotSendable extends Error {}

const GROUP_JID = /^\d+(-\d+)?@g\.us$/;
export const LINKED_PHONE = "the linked phone";

/* Where a message goes — {id, label, direct} — or null when nothing usable
 * is chosen. sendTo is '' | 'self' (the linked phone) | 'direct' (the number
 * beside it) | a group id. For 'self', id is null until the linked number is
 * known (WhatsApp connected). */
export function destinationOf(sendTo, phone, groupNames, linkedPhone = "") {
  if (sendTo === "self") return { id: linkedPhone ? directJid(linkedPhone) : null, label: LINKED_PHONE, direct: true };
  if (sendTo === "direct") return phone ? { id: directJid(phone), label: formatPhone(phone), direct: true } : null;
  if (GROUP_JID.test(sendTo)) return { id: sendTo, label: groupNames.get(sendTo) || "a group", direct: false };
  return null;
}

export const TICK_MS = 30_000;
export const RETRY_AFTER_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 6;
/* A row left `sending` for this long means the app stopped mid-send. The
 * bridge remembers the key for 24 h, so sending it again cannot post twice
 * unless the bridge restarted too. */
const STALE_SENDING_MS = 2 * 60_000;
const HISTORY_DAYS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* A short, uneven pause between messages: a burst of identical-looking posts
 * is what WhatsApp's spam detection looks for. */
const defaultGap = () => 2_000 + Math.random() * 3_000;

const wishTimeOf = (person, settings) => (parseTime(person.sendTime) !== null ? person.sendTime : settings.wishTime);

/* Today's messages: the reminder first, then the wishes by their time. A
 * wish whose person has no usable "Send to" is still listed, with to: null,
 * so the Today page and the reminder can say so; it is never sent. */
export function planDay(db, settings, date, { linkedPhone = "" } = {}) {
  const day = isoDate(date);
  const people = db.people.active();
  const groupNames = db.chats.names();

  const wishes = people
    .filter((p) => isBirthdayOn(p, date))
    .map((person) => {
      const to = destinationOf(person.sendTo, person.phone, groupNames, linkedPhone);
      return {
        key: `wish:${day}:${person.id}`,
        kind: "wish",
        day,
        time: wishTimeOf(person, settings),
        to,
        person,
        text: renderWish(person.message || defaultTemplateFor(person.kind, settings), { person, date, groupName: to && !to.direct ? to.label : "" }),
      };
    })
    .sort((a, b) => parseTime(a.time) - parseTime(b.time) || a.person.name.localeCompare(b.person.name));

  const reminderTo = destinationOf(settings.reminderTo, settings.myPhone, groupNames, linkedPhone);
  const later = reminderTo ? upcomingBirthdays(people, date, settings.daysAhead).filter((u) => u.inDays > 0) : [];
  if (!reminderTo || (!wishes.length && !later.length)) return wishes;

  const reminder = {
    key: `reminder:${day}`,
    kind: "reminder",
    day,
    time: settings.reminderTime,
    to: reminderTo,
    person: null,
    text: renderReminder({
      date,
      wishes: wishes.map((w) => ({ ...w, sent: db.deliveries.get(w.key)?.status === "sent" })),
      later,
    }),
  };
  return [reminder, ...wishes];
}

/* Whether a job with this delivery row should be tried now. */
function eligible(delivery, at, force) {
  if (!delivery) return true;
  const age = at.getTime() - Date.parse(delivery.updated_at);
  switch (delivery.status) {
    case "sent":
      return false;
    case "sending":
      return age >= STALE_SENDING_MS;
    default: // failed
      return force || (delivery.attempts < MAX_ATTEMPTS && age >= RETRY_AFTER_MS);
  }
}

export function createScheduler({ db, bridge, log, clock = () => new Date(), pause = sleep, gap = defaultGap }) {
  let running = false;
  let timer = null;
  let prunedFor = null;
  /* The linked phone's number, as the bridge last said — for "the linked
   * phone" as a destination. */
  let linkedPhone = "";
  /* For the dashboard. waiting: why messages that are due are not going out
   * (WhatsApp not connected, the bridge down), or null. send: the last run
   * that sent anything — {at, sent, failed}. */
  const last = { checkedAt: null, waiting: null, send: null };

  function today() {
    const settings = db.settings.get();
    const now = zonedNow(clock(), settings.timezone);
    return {
      settings,
      date: { year: now.year, month: now.month, day: now.day },
      minute: now.hour * 60 + now.minute,
    };
  }

  /* Whatever reads the bridge's /status tells the scheduler who is linked. */
  function noteStatus(status) {
    const phone = phoneOfJid(status?.me?.id);
    if (phone) linkedPhone = phone;
  }

  /* The bridge's status, required to be `open` — else a BridgeError. */
  async function openStatus() {
    const status = await bridge.status();
    noteStatus(status);
    if (status.state !== "open") throw new BridgeError({ code: "not_connected", state: status.state });
    return status;
  }

  /* Today's messages with where each one stands, for the dashboard. */
  function agenda() {
    const { settings, date, minute } = today();
    return planDay(db, settings, date, { linkedPhone }).map((job) => ({
      ...job,
      delivery: db.deliveries.get(job.key),
      due: parseTime(job.time) <= minute,
    }));
  }

  function waitFor(reason) {
    last.waiting = reason;
    return { outcome: "waiting", detail: reason };
  }

  /* force: Send today's messages now — ignore the time of day and the
   *        Sending switch, and retry failed messages whatever their count.
   *        Sent ones stay sent.
   * only:  one message's key (Retry on the dashboard).
   * → {outcome: busy | paused | idle | waiting | sent | failed, detail, sent, failed} */
  async function run({ force = false, only = null } = {}) {
    if (running) return { outcome: "busy" };
    running = true;
    try {
      const { settings, date, minute } = today();
      last.checkedAt = clock().toISOString();
      if (prunedFor !== isoDate(date)) {
        prunedFor = isoDate(date);
        db.deliveries.prune(isoDate(addDays(date, -HISTORY_DAYS)));
      }
      if (!settings.enabled && !force) {
        last.waiting = null;
        return { outcome: "paused" };
      }
      const due = (jobs, at) =>
        jobs.filter(
          (job) =>
            job.to &&
            (force || parseTime(job.time) <= minute) &&
            (!only || job.key === only) &&
            eligible(db.deliveries.get(job.key), at, force),
        );
      // Anything due at all, before asking the bridge anything.
      if (!due(planDay(db, settings, date, { linkedPhone }), clock()).length) {
        last.waiting = null;
        return { outcome: "idle" };
      }

      try {
        await openStatus();
      } catch (err) {
        return waitFor(err.message);
      }
      // Planned again now the linked number is known for certain.
      const jobs = due(planDay(db, settings, date, { linkedPhone }), clock()).filter((job) => job.to.id);

      let sent = 0;
      let failed = 0;
      last.waiting = null;
      for (const [i, job] of jobs.entries()) {
        if (i > 0) await pause(gap());
        db.deliveries.begin(job, clock().toISOString());
        try {
          const result = await bridge.send({ chatId: job.to.id, text: job.text, key: job.key });
          db.deliveries.succeed(job.key, result.message_id, clock().toISOString());
          sent++;
          log.info({ key: job.key, message_id: result.message_id, deduplicated: result.deduplicated }, "sent");
        } catch (err) {
          db.deliveries.fail(job.key, err.message, clock().toISOString());
          failed++;
          log.warn({ key: job.key, code: err.code }, "send failed");
          if (CONNECTION_CODES.has(err.code)) {
            last.waiting = err.message;
            break;
          }
        }
      }
      last.send = { at: clock().toISOString(), sent, failed };
      return { outcome: failed ? "failed" : "sent", sent, failed, detail: `${sent} sent${failed ? `, ${failed} failed` : ""}` };
    } finally {
      running = false;
    }
  }

  /* One message, sent and logged. */
  async function deliverOne(job, text) {
    db.deliveries.begin(job, clock().toISOString());
    try {
      const result = await bridge.send({ chatId: job.to.id, text, key: job.key });
      db.deliveries.succeed(job.key, result.message_id, clock().toISOString());
      log.info({ key: job.key, message_id: result.message_id, deduplicated: result.deduplicated }, "sent");
      return result;
    } catch (err) {
      db.deliveries.fail(job.key, err.message, clock().toISOString());
      throw err;
    }
  }

  /* "Send now" on a person: their wish, to their "Send to", straight away.
   * On their birthday it IS the day's wish — sent now instead of at its time,
   * and not again. On any other day it is an extra message; the one on the
   * birthday still goes. → {sentNow, birthday, at?} */
  async function sendNow(person) {
    const { settings, date } = today();
    await openStatus();
    const to = destinationOf(person.sendTo, person.phone, db.chats.names(), linkedPhone);
    if (!to?.id) throw new NotSendable(`Choose where ${person.name}’s wish goes first.`);
    const birthday = isBirthdayOn(person, date);
    const key = birthday ? `wish:${isoDate(date)}:${person.id}` : `now:${person.id}:${clock().getTime()}`;
    const done = db.deliveries.get(key);
    if (done?.status === "sent") return { sentNow: false, birthday, at: done.updated_at };
    const on = birthday ? date : nearestBirthday(person, date).date;
    const text = renderWish(person.message || defaultTemplateFor(person.kind, settings), { person, date: on, groupName: to.direct ? "" : to.label });
    await deliverOne({ key, day: isoDate(date), kind: "wish", person, to }, text);
    return { sentNow: true, birthday, to };
  }

  /* "Send me a preview": a person's wish, as they will get it, to your own
   * number (Settings) — or, without one, to the linked phone. */
  async function sendPreview(person) {
    const settings = db.settings.get();
    await openStatus();
    const to = settings.myPhone ? destinationOf("direct", settings.myPhone, new Map()) : destinationOf("self", "", new Map(), linkedPhone);
    if (!to?.id) throw new NotSendable("Add your WhatsApp number in Settings first — previews go there.");
    const { date } = today();
    const on = nextBirthday(person, date).date;
    const theirs = destinationOf(person.sendTo, person.phone, db.chats.names(), linkedPhone);
    const wish = renderWish(person.message || defaultTemplateFor(person.kind, settings), { person, date: on, groupName: theirs && !theirs.direct ? theirs.label : "" });
    const at = parseTime(person.sendTime) !== null ? person.sendTime : settings.wishTime;
    return deliverOne(
      { key: `preview:${person.id}:${clock().getTime()}`, day: isoDate(date), kind: "test", person, to },
      `👀 Preview — ${person.name} gets this on ${formatShortDate(on)} at ${at}${theirs ? `, to ${theirs.label}` : " (no “Send to” chosen yet)"}:\n\n${wish}`,
    );
  }

  function start() {
    const tick = () => run().catch((err) => log.error({ err: err?.stack || String(err) }, "scheduler tick failed"));
    setTimeout(tick, 5_000);
    timer = setInterval(tick, TICK_MS);
  }

  function stop() {
    clearInterval(timer);
  }

  return { run, sendNow, sendPreview, agenda, today, noteStatus, start, stop, last, isRunning: () => running };
}
