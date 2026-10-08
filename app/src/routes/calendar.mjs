/* The calendar: the month, events (add, change, delete) and tasks (add,
 * tick, change, delete). Nothing here sends anything: the scheduler sends
 * "Your day" and the reminders, at their times. */

import { DAY_MINUTES, MAX_NOTES, MAX_TITLE, REMINDERS, REPEATS, eventsOn, shiftDay } from "../calendar.mjs";
import { daysInMonth, formatShortDate, fromIsoDate, isBirthdayOn, isoDate, parseTime, weekdayOf } from "../dates.mjs";
import { HttpError, readForm } from "../http.mjs";
import { calendarPage, eventFormPage, taskFormPage } from "../views/calendar.mjs";
import { readDay } from "./forms.mjs";

/* Where a tick or a new task goes back to: Today, or a day of the calendar
 * — never anywhere else. */
const BACK = /^\/(calendar(\?month=\d{4}-\d{2}(&day=\d{4}-\d{2}-\d{2})?)?)?$/;
const backTo = (form, fallback) => (BACK.test(form.get("back")) ? form.get("back") : fallback);
const dayHref = (day) => `/calendar?month=${day.slice(0, 7)}&day=${day}`;

const readNotes = (form) => form.raw("notes").replace(/\r\n?/g, "\n").trim();

function readTitle(form, errors) {
  const title = form.get("title").replace(/\s+/g, " ");
  if (!title) errors.title = "Say what it is.";
  else if (title.length > MAX_TITLE) errors.title = `Keep it to ${MAX_TITLE} characters.`;
  return title;
}

/* An event's form, checked. → {values, errors, data} */
function readEvent(form) {
  const values = {
    title: "",
    day: form.get("day"),
    endDay: form.get("endDay"),
    time: form.get("time"),
    endTime: form.get("endTime"),
    repeat: form.get("repeat"),
    repeatUntil: form.get("repeatUntil"),
    remind: form.get("remind"),
    notes: readNotes(form),
  };
  const errors = {};
  values.title = readTitle(form, errors);
  if (!readDay(values.day)) errors.day = "Pick the day.";
  if (values.endDay && !readDay(values.endDay)) errors.endDay = "Pick a day, or leave it empty.";
  else if (values.endDay && !errors.day && values.endDay < values.day) errors.endDay = "That is before the day it starts.";
  const endDay = values.endDay && values.endDay > values.day ? values.endDay : null;
  if (values.time && parseTime(values.time) === null) errors.time = "Enter a time like 09:30, or leave it empty for all day.";
  if (values.endTime && parseTime(values.endTime) === null) errors.endTime = "Enter a time like 10:30, or leave it empty.";
  else if (values.endTime && !values.time) errors.endTime = "Give it a start time too, or leave this empty.";
  else if (values.endTime && !endDay && !errors.time && values.endTime <= values.time) errors.endTime = "That is not after it starts.";
  if (!REPEATS.some(([r]) => r === values.repeat)) values.repeat = "";
  if (values.repeat && values.repeatUntil) {
    if (!readDay(values.repeatUntil)) errors.repeatUntil = "Pick a day, or leave it empty.";
    else if (!errors.day && values.repeatUntil < values.day) errors.repeatUntil = "That is before the day it starts.";
  }
  let remind = null;
  if (values.remind !== "") {
    remind = Number(values.remind);
    if (!REMINDERS.some(([m]) => m === remind)) errors.remind = "Choose a reminder from the list.";
    else if (!values.time && remind < DAY_MINUTES) {
      errors.remind = "An all-day event is in “Your day” on the morning itself. Its reminder can be a day or more before — or give it a time.";
    }
  }
  if (values.notes.length > MAX_NOTES) errors.notes = `Keep the notes to ${MAX_NOTES.toLocaleString("en")} characters.`;
  return {
    values,
    errors,
    data: {
      title: values.title,
      day: values.day,
      endDay,
      time: values.time,
      endTime: values.time ? values.endTime : "",
      repeat: values.repeat,
      repeatUntil: values.repeat && values.repeatUntil ? values.repeatUntil : null,
      remind,
      notes: values.notes,
    },
  };
}

export function calendarRoutes({ db, scheduler, assets }) {
  const todayIso = () => isoDate(scheduler.today().date);
  const morning = () => scheduler.today().settings.reminderTime;

  function eventFrom(match) {
    const event = db.events.get(Number(match[1]));
    if (!event) throw new HttpError(404, "That event is not on the calendar — it may have been deleted.");
    return event;
  }
  function taskFrom(match) {
    const task = db.tasks.get(Number(match[1]));
    if (!task) throw new HttpError(404, "That task is not on the list — it may have been deleted.");
    return task;
  }

  /* The month: whole weeks, Sunday first, from the week of its first day to
   * the week of its last. */
  function calendar(ctx) {
    const today = todayIso();
    const params = ctx.url.searchParams;
    const chosen = readDay(params.get("day") ?? "") ? params.get("day") : null;
    const asked = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(params.get("month") ?? "");
    const month = asked && Number(asked[1]) >= 1900 && Number(asked[1]) <= 2100
      ? { year: Number(asked[1]), month: Number(asked[2]) }
      : fromIsoDate((chosen ?? today).slice(0, 7) + "-01");
    const first = isoDate({ ...month, day: 1 });
    const last = isoDate({ ...month, day: daysInMonth(month.year, month.month) });
    const from = shiftDay(first, -weekdayOf(fromIsoDate(first)));
    const to = shiftDay(last, 6 - weekdayOf(fromIsoDate(last)));
    const selected = chosen && chosen >= from && chosen <= to ? chosen : today >= first && today <= last ? today : first;

    const events = db.events.between(from, to);
    const tasks = db.tasks.dueBetween(from, to);
    const people = db.people.active();
    const journal = new Set(db.journal.daysBetween(from, to));
    const weeks = [];
    for (let day = from; day <= to; day = shiftDay(day, 1)) {
      if (weekdayOf(fromIsoDate(day)) === 0) weeks.push([]);
      weeks.at(-1).push({
        day,
        people: people.filter((p) => isBirthdayOn(p, fromIsoDate(day))),
        events: eventsOn(events, day),
        tasks: tasks.filter((t) => t.due === day),
        journal: journal.has(day),
      });
    }
    const prev = month.month === 1 ? { year: month.year - 1, month: 12 } : { year: month.year, month: month.month - 1 };
    const next = month.month === 12 ? { year: month.year + 1, month: 1 } : { year: month.year, month: month.month + 1 };
    ctx.page(
      200,
      calendarPage({ month, prev, next, today, selected, weeks, open: db.tasks.open(), done: db.tasks.done(10), assets, flash: ctx.flash }),
    );
  }

  const renderEvent = (ctx, { status = 200, event = null, values, errors = {} }) =>
    ctx.page(status, eventFormPage({ event, values, errors, morning: morning(), assets, flash: ctx.flash }));

  function eventNew(ctx) {
    const day = ctx.url.searchParams.get("day") ?? "";
    renderEvent(ctx, {
      values: { title: "", day: readDay(day) ? day : todayIso(), endDay: "", time: "", endTime: "", repeat: "", repeatUntil: "", remind: "", notes: "" },
    });
  }

  async function eventCreate(ctx) {
    const { values, errors, data } = readEvent(await readForm(ctx.req, 100_000));
    if (Object.keys(errors).length) return renderEvent(ctx, { status: 422, values, errors });
    db.events.create(data);
    ctx.back(dayHref(data.day), "ok", `Added “${data.title}”.`);
  }

  function eventEdit(ctx, match) {
    const event = eventFrom(match);
    renderEvent(ctx, {
      event,
      values: {
        ...event,
        endDay: event.endDay ?? "",
        repeatUntil: event.repeatUntil ?? "",
        remind: event.remind === null ? "" : String(event.remind),
      },
    });
  }

  async function eventUpdate(ctx, match) {
    const event = eventFrom(match);
    const { values, errors, data } = readEvent(await readForm(ctx.req, 100_000));
    if (Object.keys(errors).length) return renderEvent(ctx, { status: 422, event, values, errors });
    db.events.update(event.id, data);
    ctx.back(dayHref(data.day), "ok", `Saved “${data.title}”.`);
  }

  async function eventDelete(ctx, match) {
    await readForm(ctx.req);
    const event = db.events.get(Number(match[1]));
    if (event) db.events.remove(event.id);
    ctx.back(event ? dayHref(event.day) : "/calendar", "ok", event ? `Deleted “${event.title}”.` : "Already deleted.");
  }

  /* A new task, from the Tasks box: its title, and a due day or none. */
  async function taskCreate(ctx) {
    const form = await readForm(ctx.req);
    const back = backTo(form, "/calendar");
    const errors = {};
    const title = readTitle(form, errors);
    const due = form.get("due");
    if (errors.title) return ctx.back(back, "error", `The task was not added: ${errors.title}`);
    if (due && !readDay(due)) return ctx.back(back, "error", "The task was not added: that due day is not a day.");
    db.tasks.create({ title, due: due || null });
    ctx.back(back, "ok", `Added “${title}”${due ? ` — due ${due === todayIso() ? "today" : formatShortDate(fromIsoDate(due))}` : ""}.`);
  }

  async function taskDone(ctx, match) {
    const form = await readForm(ctx.req);
    const task = taskFrom(match);
    const done = form.get("done") === "1";
    db.tasks.setDone(task.id, done);
    ctx.back(backTo(form, "/calendar"), "ok", done ? `Done: “${task.title}”.` : `“${task.title}” is to do again.`);
  }

  const renderTask = (ctx, { status = 200, task, values, errors = {} }) =>
    ctx.page(status, taskFormPage({ task, values, errors, assets, flash: ctx.flash }));

  function taskEdit(ctx, match) {
    const task = taskFrom(match);
    renderTask(ctx, { task, values: { title: task.title, due: task.due ?? "", notes: task.notes, done: task.done } });
  }

  async function taskUpdate(ctx, match) {
    const task = taskFrom(match);
    const form = await readForm(ctx.req, 100_000);
    const errors = {};
    const values = { title: readTitle(form, errors), due: form.get("due"), notes: readNotes(form), done: form.has("done") };
    if (values.due && !readDay(values.due)) errors.due = "Pick a day, or leave it empty.";
    if (values.notes.length > MAX_NOTES) errors.notes = `Keep the notes to ${MAX_NOTES.toLocaleString("en")} characters.`;
    if (Object.keys(errors).length) return renderTask(ctx, { status: 422, task, values, errors });
    db.transaction(() => {
      db.tasks.update(task.id, { title: values.title, due: values.due || null, notes: values.notes });
      db.tasks.setDone(task.id, values.done);
    });
    ctx.back(values.due ? dayHref(values.due) : "/calendar", "ok", "Task saved.");
  }

  async function taskDelete(ctx, match) {
    await readForm(ctx.req);
    const task = db.tasks.get(Number(match[1]));
    if (task) db.tasks.remove(task.id);
    ctx.back("/calendar", "ok", task ? `Deleted “${task.title}”.` : "Already deleted.");
  }

  return [
    ["GET", /^\/calendar$/, calendar],
    ["GET", /^\/events\/new$/, eventNew],
    ["POST", /^\/events$/, eventCreate],
    ["GET", /^\/events\/(\d+)$/, eventEdit],
    ["POST", /^\/events\/(\d+)$/, eventUpdate],
    ["POST", /^\/events\/(\d+)\/delete$/, eventDelete],
    ["POST", /^\/tasks$/, taskCreate],
    ["GET", /^\/tasks\/(\d+)$/, taskEdit],
    ["POST", /^\/tasks\/(\d+)$/, taskUpdate],
    ["POST", /^\/tasks\/(\d+)\/done$/, taskDone],
    ["POST", /^\/tasks\/(\d+)\/delete$/, taskDelete],
  ];
}
