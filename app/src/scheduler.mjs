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
 * Then the calendar's, to where Settings says calendar messages go (the
 * linked phone, unless changed): "Your day" at the reminder time — the day's
 * events, the tasks due, tomorrow's events — when there is anything to say,
 * and each event's reminder at its time.
 *
 * Each message has a key — reminder:<day>, wish:<day>:<person>,
 * agenda:<day>, event:<event>:<the day it starts>:<minutes before> — and a
 * message whose key is marked sent is never sent again: not on the next
 * tick, not after a restart, not when someone presses Send now. If the
 * computer was asleep or off at the set time, the day's messages go out when
 * it is back, the same day. A day's messages are never sent on a later day.
 *
 * WhatsApp not being connected is not a failed message: nothing is attempted
 * (and no retry is used up) until the bridge says `open`. A message that
 * WhatsApp refuses is retried every 10 minutes, at most 6 times a day.
 *
 * A wish that is not sent is told about in an alert, a WhatsApp message to
 * where Settings says (the linked phone, unless changed): at once when
 * WhatsApp refuses it for a reason someone has to fix, else when its last
 * try fails; and the next morning, at the reminder time, for the wishes of a
 * day that ended before they could go. Alerts wait for WhatsApp like any
 * message, and go out once each. */

import { BridgeError, CONNECTION_CODES, explain } from "./bridge.mjs";
import { DAY_MINUTES, daysBetween, eventsOn, shiftDay, startsBetween } from "./calendar.mjs";
import {
  addDays,
  formatShortDate,
  fromIsoDate,
  isBirthdayOn,
  isoDate,
  nearestBirthday,
  nextBirthday,
  parseTime,
  upcomingBirthdays,
  zonedNow,
} from "./dates.mjs";
import {
  defaultTemplateFor,
  renderAgenda,
  renderEventReminder,
  renderMissedAlert,
  renderRefusedAlert,
  renderReminder,
  renderTestAlert,
  renderWish,
} from "./messages.mjs";
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
/* Refusals that trying again will not cure until someone changes something:
 * the alert goes at the first one, not after the last try. */
const NEEDS_YOU = new Set(["not_a_member", "admins_only", "not_on_whatsapp", "invalid_chat_id", "invalid_text"]);
/* An alert that could not go out within this many days is dropped. */
const ALERT_DAYS = 3;
/* How far back the morning look over days gone by reaches, at most. */
const REVIEW_DAYS = 7;
const DAY_MS = 86_400_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* A short, uneven pause between messages: a burst of identical-looking posts
 * is what WhatsApp's spam detection looks for. */
const defaultGap = () => 2_000 + Math.random() * 3_000;

const wishTimeOf = (person, settings) => (parseTime(person.sendTime) !== null ? person.sendTime : settings.wishTime);

/* Whether a person was added to the list after `day` — too late for that
 * day's wish to have gone. */
function addedAfter(person, day, timeZone) {
  const at = Date.parse(person.createdAt);
  return Number.isFinite(at) && isoDate(zonedNow(new Date(at), timeZone)) > isoDate(day);
}

const clockOf = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/* The calendar's messages on a day, to `to`: "Your day" at the reminder
 * time, when it has anything to say, and the reminders whose time falls on
 * this day — for an event that starts today, or up to a week from now. An
 * all-day event's reminder goes at the reminder time, the days before it
 * that it says. */
function planCalendar(db, settings, date, to) {
  if (!to) return [];
  const day = isoDate(date);
  const tomorrow = shiftDay(day, 1);
  const events = db.events.between(day, shiftDay(day, 8));
  const jobs = [];
  const today = eventsOn(events, day);
  const next = eventsOn(events, tomorrow).filter((o) => o.dayOf === 1);
  const tasks = db.tasks.dueBy(day);
  if (today.length || tasks.length || next.length) {
    jobs.push({
      key: `agenda:${day}`,
      kind: "agenda",
      day,
      time: settings.reminderTime,
      to,
      person: null,
      title: null,
      text: renderAgenda({ date, today, tasks, tomorrow: next }),
    });
  }
  const morning = parseTime(settings.reminderTime) ?? 0;
  for (const event of events) {
    if (event.remind === null) continue;
    for (const start of startsBetween(event, day, shiftDay(day, Math.ceil(event.remind / DAY_MINUTES)))) {
      const ahead = daysBetween(day, start) * DAY_MINUTES;
      const at = event.time ? ahead + parseTime(event.time) - event.remind : ahead === event.remind ? morning : -1;
      if (at < 0 || at >= DAY_MINUTES) continue;
      jobs.push({
        key: `event:${event.id}:${start}:${event.remind}`,
        kind: "event",
        day,
        time: clockOf(at),
        to,
        person: null,
        title: event.title,
        text: renderEventReminder({ event, start, date }),
      });
    }
  }
  return jobs;
}

/* Today's messages: the reminder first, then the wishes and the calendar's
 * messages by their time. A wish whose person has no usable "Send to" is
 * still listed, with to: null, so the Today page and the reminder can say
 * so; it is never sent. */
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

  // Sorted by time alone: a wish and a calendar message at the same time
  // keep this order, wishes first.
  const calendar = planCalendar(db, settings, date, destinationOf(settings.calendarTo, settings.myPhone, groupNames, linkedPhone));
  const messages = [...wishes, ...calendar].sort((a, b) => parseTime(a.time) - parseTime(b.time));

  const reminderTo = destinationOf(settings.reminderTo, settings.myPhone, groupNames, linkedPhone);
  const later = reminderTo ? upcomingBirthdays(people, date, settings.daysAhead).filter((u) => u.inDays > 0) : [];
  if (!reminderTo || (!wishes.length && !later.length)) return messages;

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
  return [reminder, ...messages];
}

/* Whether a job with this delivery row should be tried now. */
function eligible(delivery, at, force) {
  if (!delivery) return true;
  const age = at.getTime() - Date.parse(delivery.updated_at);
  switch (delivery.status) {
    case "sent":
      return false;
    case "pending": // an alert not tried yet
      return true;
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

  /* In the morning — at the reminder time — the days gone by are looked
   * over for wishes that were not sent: the computer was off or asleep, or
   * WhatsApp not connected, until the day ended. What is found goes in one
   * alert. Each day is looked over once; a new install starts from today,
   * and so does sending turned back on (sendingTurnedOn). */
  function reviewPastDays(settings, date, minute) {
    const through = db.alerts.checkedThrough();
    const yesterday = isoDate(addDays(date, -1));
    if (!through) {
      db.alerts.setCheckedThrough(isoDate(date));
      return;
    }
    if (through >= yesterday || minute < (parseTime(settings.reminderTime) ?? 0)) return;
    if (settings.enabled && settings.alertTo) {
      const days = [];
      let day = addDays(fromIsoDate(through), 1);
      if (isoDate(day) < isoDate(addDays(date, -REVIEW_DAYS))) day = addDays(date, -REVIEW_DAYS);
      for (; isoDate(day) <= yesterday; day = addDays(day, 1)) {
        const items = planDay(db, settings, day, { linkedPhone })
          .filter((job) => job.kind === "wish" && job.to && !addedAfter(job.person, day, settings.timezone))
          .map((job) => ({ job, delivery: db.deliveries.get(job.key) }))
          .filter(({ delivery }) => delivery?.status !== "sent" && !delivery?.alerted_at);
        if (items.length) days.push({ date: day, items });
      }
      if (days.length) {
        db.alerts.create(
          {
            key: `alert:missed:${yesterday}`,
            day: isoDate(date),
            text: renderMissedAlert({ days }),
            about: days.flatMap((d) => d.items.filter((item) => item.delivery).map((item) => item.job.key)),
          },
          clock().toISOString(),
        );
      }
    }
    db.alerts.setCheckedThrough(yesterday);
  }

  /* Sending turned back on: the days it was off hold no missed wishes, so
   * the next look back starts from today. */
  function sendingTurnedOn() {
    const yesterday = isoDate(addDays(today().date, -1));
    const through = db.alerts.checkedThrough();
    if (!through || through < yesterday) db.alerts.setCheckedThrough(yesterday);
  }

  const alertCutoff = () => new Date(clock().getTime() - ALERT_DAYS * DAY_MS).toISOString();

  /* The alerts to send now: not sent yet, made in the last few days, and
   * not waiting out a retry. A test alert is never sent again. */
  function unsentAlerts() {
    const at = clock();
    return db.alerts.unsent(alertCutoff()).filter((alert) => !alert.key.startsWith("alert:test:") && eligible(alert, at, false));
  }

  /* Each alert a message of its own, to where Settings says alerts go now.
   * → {sent, failed} */
  async function sendAlerts(settings, alerts, afterOthers) {
    const counts = { sent: 0, failed: 0 };
    const to = destinationOf(settings.alertTo, settings.myPhone, db.chats.names(), linkedPhone);
    if (!to?.id) return counts;
    for (const [i, alert] of alerts.entries()) {
      if (i > 0 || afterOthers) await pause(gap());
      db.deliveries.begin({ key: alert.key, day: alert.day, kind: "alert", to }, clock().toISOString());
      try {
        const result = await bridge.send({ chatId: to.id, text: alert.text, key: alert.key });
        db.deliveries.succeed(alert.key, result.message_id, clock().toISOString());
        counts.sent++;
        log.info({ key: alert.key, message_id: result.message_id, deduplicated: result.deduplicated }, "alert sent");
      } catch (err) {
        db.deliveries.fail(alert.key, err.message, clock().toISOString());
        counts.failed++;
        log.warn({ key: alert.key, code: err.code }, "alert not sent");
        if (CONNECTION_CODES.has(err.code)) {
          last.waiting = err.message;
          break;
        }
      }
    }
    return counts;
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
        db.alerts.expire(alertCutoff(), clock().toISOString());
      }
      reviewPastDays(settings, date, minute);
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
      // Alerts go while sending is on; a Retry of one message is that only.
      const alertsOn = settings.enabled && Boolean(settings.alertTo);
      const alertsDue = () => (alertsOn && !only ? unsentAlerts() : []);
      // Anything due at all, before asking the bridge anything.
      if (!due(planDay(db, settings, date, { linkedPhone }), clock()).length && !alertsDue().length) {
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
      const refused = [];
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
          const delivery = db.deliveries.get(job.key);
          if (!delivery.alerted_at && (NEEDS_YOU.has(err.code) || delivery.attempts >= MAX_ATTEMPTS)) refused.push({ job, delivery });
          if (CONNECTION_CODES.has(err.code)) {
            last.waiting = err.message;
            break;
          }
        }
      }
      if (refused.length && alertsOn) {
        db.alerts.create(
          {
            key: `alert:${refused[0].job.key}`,
            day: isoDate(date),
            text: renderRefusedAlert({ items: refused, maxAttempts: MAX_ATTEMPTS }),
            about: refused.map((r) => r.job.key),
          },
          clock().toISOString(),
        );
      }
      // Then the alerts — unless the connection has just failed.
      if (!last.waiting) {
        const alerts = await sendAlerts(settings, alertsDue(), jobs.length > 0);
        sent += alerts.sent;
        failed += alerts.failed;
      }
      last.send = { at: clock().toISOString(), sent, failed };
      return { outcome: failed ? "failed" : "sent", sent, failed, detail: `${sent} sent${failed ? `, ${failed} failed` : ""}` };
    } finally {
      running = false;
    }
  }

  /* One message, sent and logged. */
  async function deliverOne(job, text) {
    db.deliveries.begin(job, clock().toISOString(), job.kind === "alert" ? text : null);
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

  /* "Send a test alert": what an alert looks like, to where alerts go (as
   * saved). → where it went */
  async function sendTestAlert() {
    const settings = db.settings.get();
    if (!settings.alertTo) throw new NotSendable("Alerts are off. Choose where they go, and save, first.");
    await openStatus();
    const to = destinationOf(settings.alertTo, settings.myPhone, db.chats.names(), linkedPhone);
    if (!to?.id) throw new NotSendable("Choose where alerts go, and save, first.");
    await deliverOne({ key: `alert:test:${clock().getTime()}`, day: isoDate(today().date), kind: "alert", person: null, to }, renderTestAlert());
    return to;
  }

  /* The answer to a 📅 message (capture.mjs): to the linked phone's own
   * chat — Message yourself — never the group it came from. It goes while
   * sending is paused too, like Send now: it answers something its owner
   * just did. Once per key. */
  async function sendToSelf({ key, title, text }) {
    if (db.deliveries.get(key)?.status === "sent") return;
    await openStatus();
    const to = destinationOf("self", "", new Map(), linkedPhone);
    if (!to?.id) throw new NotSendable("WhatsApp has not said which number is linked yet.");
    await deliverOne({ key, day: isoDate(today().date), kind: "capture", person: null, title, to }, text);
  }

  function start() {
    const tick = () => run().catch((err) => log.error({ err: err?.stack || String(err) }, "scheduler tick failed"));
    setTimeout(tick, 5_000);
    timer = setInterval(tick, TICK_MS);
  }

  function stop() {
    clearInterval(timer);
  }

  return {
    run,
    sendNow,
    sendPreview,
    sendTestAlert,
    sendToSelf,
    sendingTurnedOn,
    agenda,
    today,
    noteStatus,
    start,
    stop,
    last,
    isRunning: () => running,
  };
}
