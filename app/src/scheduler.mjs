/* The clock. Twice a minute it works out what today's messages are, and sends
 * the ones that are due and not yet sent:
 *
 *   - the reminder, at the reminder time, into every group marked for
 *     reminders — today's birthdays and the next few days';
 *   - a wish for each person whose birthday it is, at the wish time, into
 *     each group they are wished in.
 *
 * Each message has a key — reminder:<day>:<group>, wish:<day>:<person>:<group>
 * — and a message whose key is marked sent is never sent again: not on the
 * next tick, not after a restart, not when someone presses Send now. If the
 * computer was asleep or off at the set time, the day's messages go out when
 * it is back, the same day. A day's messages are never sent on a later day.
 *
 * WhatsApp not being connected is not a failed message: nothing is attempted
 * (and no retry is used up) until the bridge says `open`. A message that
 * WhatsApp refuses is retried every 10 minutes, at most 6 times a day. */

import { CONNECTION_CODES, explain } from "./bridge.mjs";
import {
  addDays,
  isBirthdayOn,
  isoDate,
  parseTime,
  upcomingBirthdays,
  zonedNow,
} from "./dates.mjs";
import { TEST_MESSAGE, renderReminder, renderWish } from "./messages.mjs";

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

/* Today's messages, in the order they go out: reminders first. */
export function planDay(db, settings, date) {
  const day = isoDate(date);
  const people = db.people.active();
  const chats = db.chats.all();
  const assignments = db.people.assignments();
  const wishChats = chats.filter((c) => c.wishes);
  const todays = people.filter((p) => isBirthdayOn(p, date));
  const isWishedIn = (person, chat) => Boolean(assignments.get(person.id)?.has(chat.id));
  const jobs = [];

  const reminderChats = chats.filter((c) => c.reminders);
  const entries = reminderChats.length ? upcomingBirthdays(people, date, settings.daysAhead) : [];
  if (entries.length) {
    const wishGroups = new Map(
      todays.map((p) => [p.id, wishChats.filter((c) => isWishedIn(p, c)).map((c) => c.subject)]),
    );
    const text = renderReminder({ date, entries, wishGroups, wishTime: settings.wishTime });
    for (const chat of reminderChats) {
      jobs.push({ key: `reminder:${day}:${chat.id}`, kind: "reminder", day, time: settings.reminderTime, chat, person: null, text });
    }
  }

  for (const person of todays) {
    for (const chat of wishChats) {
      if (!isWishedIn(person, chat)) continue;
      jobs.push({
        key: `wish:${day}:${person.id}:${chat.id}`,
        kind: "wish",
        day,
        time: settings.wishTime,
        chat,
        person,
        text: renderWish(chat.template || settings.template, { person, date, groupName: chat.subject }),
      });
    }
  }
  return jobs;
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

  /* Today's messages with where each one stands, for the dashboard. */
  function agenda() {
    const { settings, date, minute } = today();
    return planDay(db, settings, date).map((job) => ({
      ...job,
      delivery: db.deliveries.get(job.key),
      due: parseTime(job.time) <= minute,
    }));
  }

  function waitFor(reason) {
    last.waiting = reason;
    return { outcome: "waiting", detail: reason };
  }

  /* force: Send now — ignore the time of day and the Sending switch, and
   *        retry failed messages whatever their count. Sent ones stay sent.
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
      const at = clock();
      const jobs = planDay(db, settings, date).filter(
        (job) =>
          (force || parseTime(job.time) <= minute) &&
          (!only || job.key === only) &&
          eligible(db.deliveries.get(job.key), at, force),
      );
      if (!jobs.length) {
        last.waiting = null;
        return { outcome: "idle" };
      }

      try {
        const status = await bridge.status();
        if (status.state !== "open") return waitFor(explain("not_connected", status.state));
      } catch (err) {
        return waitFor(err.message);
      }

      let sent = 0;
      let failed = 0;
      last.waiting = null;
      for (const [i, job] of jobs.entries()) {
        if (i > 0) await pause(gap());
        db.deliveries.begin(job, clock().toISOString());
        try {
          const result = await bridge.send({ chatId: job.chat.id, text: job.text, key: job.key });
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

  /* The Groups page's "Send a test message". Logged like any other message. */
  async function sendTest(chat) {
    const { date } = today();
    const key = `test:${chat.id}:${clock().getTime()}`;
    db.deliveries.begin({ key, day: isoDate(date), kind: "test", chat }, clock().toISOString());
    try {
      const result = await bridge.send({ chatId: chat.id, text: TEST_MESSAGE, key });
      db.deliveries.succeed(key, result.message_id, clock().toISOString());
      return result;
    } catch (err) {
      db.deliveries.fail(key, err.message, clock().toISOString());
      throw err;
    }
  }

  function start() {
    const tick = () => run().catch((err) => log.error({ err: err?.stack || String(err) }, "scheduler tick failed"));
    setTimeout(tick, 5_000);
    timer = setInterval(tick, TICK_MS);
  }

  function stop() {
    clearInterval(timer);
  }

  return { run, sendTest, agenda, today, start, stop, last, isRunning: () => running };
}
