/* The calendar: the month, a day's events and birthdays, the tasks, the
 * event and task forms — and "Your day" on the Today page. */

import { MAX_NOTES, MAX_TITLE, REMINDERS, REPEATS, reminderLabel, repeatLabel, timeRange } from "../calendar.mjs";
import { MONTHS, WEEKDAYS, formatShortDate, fromIsoDate, isoDate, weekdayOf } from "../dates.mjs";
import { occasionNote } from "../messages.mjs";
import { html, plural, raw, selectOptions } from "./html.mjs";
import { iconOf, layout } from "./layout.mjs";
import { longDate } from "./notes.mjs";

const monthKey = ({ year, month }) => `${year}-${String(month).padStart(2, "0")}`;
const dayHref = (day) => `/calendar?month=${day.slice(0, 7)}&day=${day}`;
const shortDay = (day) => formatShortDate(fromIsoDate(day));

/* When a task is due, said from today. */
function dueWord(due, today) {
  if (!due) return "";
  if (due < today) return `overdue · ${shortDay(due)}`;
  if (due === today) return "today";
  return shortDay(due);
}

/* What an event is, beyond its title: which of its days, how it repeats,
 * its reminder. */
function eventDetails(o) {
  const parts = [];
  if (o.days > 1) parts.push(`day ${o.dayOf} of ${o.days}`);
  if (o.event.repeat) parts.push(repeatLabel(o.event.repeat).toLowerCase());
  if (o.event.remind !== null) parts.push(`reminder ${reminderLabel(o.event.remind).toLowerCase()}`);
  return parts.join(" · ");
}

/* A task's tick: a form, so it works without the script. */
function taskTick(task, back) {
  const label = task.done ? `Mark “${task.title}” not done` : `Mark “${task.title}” done`;
  return html`<form method="post" action="/tasks/${task.id}/done" class="inline-form task__tick">
    <input type="hidden" name="done" value="${task.done ? "0" : "1"}">
    <input type="hidden" name="back" value="${back}">
    <button type="submit" class="tickbox${task.done ? " is-done" : ""}" aria-label="${label}" title="${label}"><span aria-hidden="true">${task.done ? "✓" : ""}</span></button>
  </form>`;
}

function taskItem(task, { today, back, showDue = true }) {
  const due = showDue ? dueWord(task.due, today) : "";
  return html`<li class="task${task.done ? " is-done" : ""}${task.due && task.due < today && !task.done ? " is-overdue" : ""}">
  ${taskTick(task, back)}
  <a class="task__title" href="/tasks/${task.id}">${task.title}</a>
  ${due ? html`<span class="task__due">${due}</span>` : ""}
</li>`;
}

/* A day's events, as a list: time (or all day), title, details. */
function eventItems(events) {
  return events.map(
    (o) => html`<li class="cal-event">
  <span class="cal-event__time">${timeRange(o.event) || "All day"}</span>
  <span><a href="/events/${o.event.id}">${o.event.title}</a>${eventDetails(o) ? html` <span class="muted">· ${eventDetails(o)}</span>` : ""}</span>
</li>`,
  );
}

/* ------------------------------------------------------------- Today */

/* "Your day" on the Today page: the day's events, and the tasks due. */
export function yourDayCard({ date, events, tasks }) {
  const today = isoDate(date);
  return html`<section class="card your-day" aria-labelledby="your-day-title">
  <h2 id="your-day-title">Your day</h2>
  ${events.length ? html`<ul class="cal-events">${eventItems(events)}</ul>` : html`<p class="empty">Nothing on the calendar today.</p>`}
  ${tasks.length ? html`<h3 class="eyebrow">To do</h3><ul class="tasks__list">${tasks.map((t) => taskItem(t, { today, back: "/" }))}</ul>` : ""}
  <p class="your-day__links"><a href="${dayHref(today)}">Open the calendar</a> · <a href="/events/new?day=${today}">Add an event</a></p>
</section>`;
}

/* ---------------------------------------------------------- the month */

function dayCell(d, { month, today, selected }) {
  const date = fromIsoDate(d.day);
  const others = date.month !== month.month;
  const count = d.people.length + d.events.length + d.tasks.length;
  const items = [
    ...d.people.map((p) => html`<li class="cal__item cal__item--person"><span aria-hidden="true">${iconOf(p.kind)}</span> ${p.name}</li>`),
    ...d.events.map(
      (o) => html`<li class="cal__item cal__item--event${o.event.time ? "" : " is-allday"}">${o.event.time ? html`<span class="cal__time">${o.event.time}</span> ` : ""}${o.event.title}</li>`,
    ),
    ...d.tasks.map((t) => html`<li class="cal__item cal__item--task${t.done ? " is-done" : ""}"><span aria-hidden="true">${t.done ? "☑" : "☐"}</span> ${t.title}</li>`),
  ];
  const what = [
    d.people.length ? plural(d.people.length, "birthday or anniversary", "birthdays and anniversaries") : "",
    d.events.length ? plural(d.events.length, "event") : "",
    d.tasks.length ? plural(d.tasks.length, "task") : "",
    d.journal ? "a journal page" : "",
  ].filter(Boolean);
  const classes = ["cal__day", others ? "is-other" : "", d.day === today ? "is-today" : "", d.day === selected ? "is-selected" : "", weekdayOf(date) === 0 ? "is-sunday" : ""];
  return html`<td class="${classes.filter(Boolean).join(" ")}">
  <a class="cal__num" href="${dayHref(d.day)}" aria-label="${longDate(date)}${what.length ? `: ${what.join(", ")}` : ""}"${d.day === today ? raw(' aria-current="date"') : ""}>${date.day}</a>
  ${d.journal ? html`<span class="cal__journal" title="Journal page" aria-hidden="true">✎</span>` : ""}
  ${items.length ? html`<ul class="cal__items" aria-hidden="true">${items.slice(0, 3)}</ul>${items.length > 3 ? html`<span class="cal__more" aria-hidden="true">+${items.length - 3} more</span>` : ""}` : ""}
  ${count ? html`<span class="cal__dots" aria-hidden="true">${d.people.length ? raw('<i class="dot-person"></i>') : ""}${d.events.length ? raw('<i class="dot-event"></i>') : ""}${d.tasks.length ? raw('<i class="dot-task"></i>') : ""}</span>` : ""}
</td>`;
}

function dayPanel(d, { today, back }) {
  const date = fromIsoDate(d.day);
  return html`<section class="card cal-day" aria-labelledby="cal-day-title">
  <h2 id="cal-day-title">${longDate(date)}${d.day === today ? html` <span class="chip chip--today">Today</span>` : ""}</h2>
  ${d.people.length
    ? html`<ul class="cal-people">${d.people.map((p) => {
        const note = occasionNote(p, date);
        return html`<li><span aria-hidden="true">${iconOf(p.kind)}</span> <a href="/people/${p.id}">${p.name}</a>${note ? html` <span class="muted">· ${note}</span>` : ""}</li>`;
      })}</ul>`
    : ""}
  ${d.events.length ? html`<ul class="cal-events">${eventItems(d.events)}</ul>` : ""}
  ${d.tasks.length ? html`<ul class="tasks__list">${d.tasks.map((t) => taskItem(t, { today, back, showDue: false }))}</ul>` : ""}
  ${d.people.length || d.events.length || d.tasks.length ? "" : html`<p class="empty">Nothing on this day.</p>`}
  <p class="cal-day__actions">
    <a class="button button--small" href="/events/new?day=${d.day}">Add an event</a>
    <a class="button button--quiet button--small" href="/journal/${d.day}">${d.journal ? "Journal page" : "Write in the journal"}</a>
  </p>
</section>`;
}

function tasksPanel({ open, done, today, selected, back }) {
  const groups = [
    ["Overdue", open.filter((t) => t.due && t.due < today)],
    ["Today", open.filter((t) => t.due === today)],
    ["Coming up", open.filter((t) => t.due && t.due > today)],
    ["Any time", open.filter((t) => !t.due)],
  ].filter(([, list]) => list.length);
  return html`<section class="card tasks" aria-labelledby="tasks-title">
  <h2 id="tasks-title">Tasks</h2>
  <form method="post" action="/tasks" class="task-add">
    <input type="hidden" name="back" value="${back}">
    <label class="visually-hidden" for="task-title">New task</label>
    <input id="task-title" name="title" maxlength="${MAX_TITLE}" placeholder="Add a task" autocomplete="off" required>
    <label class="visually-hidden" for="task-due">Due</label>
    <input id="task-due" type="date" name="due" value="${selected === today ? "" : selected}" title="Due (optional)">
    <button type="submit" class="button button--small">Add</button>
  </form>
  ${groups.length
    ? groups.map(([label, list]) => html`<h3 class="eyebrow">${label}</h3><ul class="tasks__list">${list.map((t) => taskItem(t, { today, back, showDue: label !== "Today" }))}</ul>`)
    : html`<p class="empty">Nothing to do. A task can have a day it is due, or none.</p>`}
  ${done.length
    ? html`<details class="tasks__done"><summary>Done lately</summary><ul class="tasks__list">${done.map((t) => taskItem(t, { today, back, showDue: false }))}</ul></details>`
    : ""}
</section>`;
}

export function calendarPage({ month, prev, next, today, selected, weeks, open, done, assets, flash }) {
  const back = dayHref(selected);
  const selectedDay = weeks.flat().find((d) => d.day === selected);
  const thisMonth = monthKey(month) === today.slice(0, 7);
  return layout({
    title: `${MONTHS[month.month - 1]} ${month.year}`,
    active: "calendar",
    wide: true,
    assets,
    flash,
    body: html`<header class="page-head">
  <div>
    <h1>Calendar</h1>
    <p class="lede">${MONTHS[month.month - 1]} ${month.year}</p>
  </div>
  <div class="page-head__actions">
    <nav class="day-nav" aria-label="Other months">
      <a class="button button--quiet button--small" href="/calendar?month=${monthKey(prev)}" rel="prev"><span aria-hidden="true">←</span> ${MONTHS[prev.month - 1].slice(0, 3)}</a>
      ${thisMonth ? "" : html`<a class="button button--quiet button--small" href="/calendar">Today</a>`}
      <a class="button button--quiet button--small" href="/calendar?month=${monthKey(next)}" rel="next">${MONTHS[next.month - 1].slice(0, 3)} <span aria-hidden="true">→</span></a>
    </nav>
    <a class="button" href="/events/new?day=${selected}">Add an event</a>
  </div>
</header>
<div class="cal-layout">
  <div class="card card--flush cal-wrap">
    <table class="cal">
      <caption class="visually-hidden">${MONTHS[month.month - 1]} ${month.year}. Choose a day to see it in full.</caption>
      <thead><tr>${WEEKDAYS.map((w, i) => html`<th scope="col"${i === 0 ? raw(' class="is-sunday"') : ""}><abbr title="${w}">${w.slice(0, 3)}</abbr></th>`)}</tr></thead>
      <tbody>${weeks.map((week) => html`<tr>${week.map((d) => dayCell(d, { month, today, selected }))}</tr>`)}</tbody>
    </table>
  </div>
  <div class="cal-side">
    ${selectedDay ? dayPanel(selectedDay, { today, back }) : ""}
    ${tasksPanel({ open, done, today, selected, back })}
  </div>
</div>`,
  });
}

/* ------------------------------------------------------------ the forms */

export function eventFormPage({ event = null, values, errors = {}, morning, assets, flash }) {
  const invalid = (e) => (e ? raw(' aria-invalid="true"') : "");
  const error = (e) => (e ? html`<span class="field__error">${e}</span>` : "");
  const heading = event ? "Edit event" : "Add an event";
  const back = dayHref(event?.day ?? values.day);
  return layout({
    title: heading,
    active: "calendar",
    assets,
    flash,
    body: html`<p class="crumbs"><a href="${back}">Calendar</a></p>
<h1>${heading}</h1>
<form method="post" action="${event ? `/events/${event.id}` : "/events"}" class="card form" data-unsaved novalidate>
  <label class="field">
    <span class="field__label">What</span>
    <input name="title" value="${values.title}" maxlength="${MAX_TITLE}" required autocomplete="off"${event ? "" : raw(" autofocus")}${invalid(errors.title)}>
    ${error(errors.title)}
  </label>
  <div class="field-row">
    <label class="field">
      <span class="field__label">Day</span>
      <input type="date" name="day" value="${values.day}" required${invalid(errors.day)}>
      ${error(errors.day)}
    </label>
    <label class="field">
      <span class="field__label">Until <span class="optional">for more than one day</span></span>
      <input type="date" name="endDay" value="${values.endDay}"${invalid(errors.endDay)}>
      ${error(errors.endDay)}
    </label>
  </div>
  <div class="field-row">
    <label class="field">
      <span class="field__label">From <span class="optional">empty: all day</span></span>
      <input type="time" name="time" value="${values.time}"${invalid(errors.time)}>
      ${error(errors.time)}
    </label>
    <label class="field">
      <span class="field__label">To <span class="optional">optional</span></span>
      <input type="time" name="endTime" value="${values.endTime}"${invalid(errors.endTime)}>
      ${error(errors.endTime)}
    </label>
  </div>
  <div class="field-row">
    <label class="field">
      <span class="field__label">Repeats</span>
      <select name="repeat">${selectOptions(REPEATS, values.repeat)}</select>
    </label>
    <label class="field">
      <span class="field__label">Repeats until <span class="optional">empty: for good</span></span>
      <input type="date" name="repeatUntil" value="${values.repeatUntil}"${invalid(errors.repeatUntil)}>
      ${error(errors.repeatUntil)}
    </label>
  </div>
  <label class="field field--short">
    <span class="field__label">Reminder</span>
    <select name="remind"${invalid(errors.remind)}>${selectOptions([["", "No reminder"], ...REMINDERS], values.remind)}</select>
    ${error(errors.remind)}
    <span class="hint">On WhatsApp, to where calendar messages go (Settings). An all-day event’s reminder goes at ${morning}, the day or days before; on the day itself it is in “Your day”.</span>
  </label>
  <label class="field">
    <span class="field__label">Notes <span class="optional">optional — they go with the reminder</span></span>
    <textarea name="notes" rows="4" maxlength="${MAX_NOTES}">${values.notes}</textarea>
  </label>
  <div class="form__actions">
    <button type="submit" class="button">${event ? "Save changes" : "Add event"}</button>
    <a href="${back}" class="linkish">Cancel</a>
  </div>
</form>
${event
  ? html`<form method="post" action="/events/${event.id}/delete" class="inline-form" data-confirm="Delete “${event.title}”?${event.repeat ? " Every time it repeats goes too." : ""}">
  <button type="submit" class="button button--danger-quiet">Delete event</button>
</form>`
  : ""}`,
  });
}

export function taskFormPage({ task, values, errors = {}, assets, flash }) {
  const invalid = (e) => (e ? raw(' aria-invalid="true"') : "");
  const back = values.due ? dayHref(values.due) : "/calendar";
  return layout({
    title: task.title,
    active: "calendar",
    assets,
    flash,
    body: html`<p class="crumbs"><a href="${back}">Calendar</a></p>
<h1>Task</h1>
<form method="post" action="/tasks/${task.id}" class="card form" data-unsaved novalidate>
  <label class="field">
    <span class="field__label">What</span>
    <input name="title" value="${values.title}" maxlength="${MAX_TITLE}" required autocomplete="off"${invalid(errors.title)}>
    ${errors.title ? html`<span class="field__error">${errors.title}</span>` : ""}
  </label>
  <label class="field field--short">
    <span class="field__label">Due <span class="optional">optional</span></span>
    <input type="date" name="due" value="${values.due}"${invalid(errors.due)}>
    ${errors.due ? html`<span class="field__error">${errors.due}</span>` : ""}
  </label>
  <label class="field">
    <span class="field__label">Notes <span class="optional">optional</span></span>
    <textarea name="notes" rows="4" maxlength="${MAX_NOTES}">${values.notes}</textarea>
  </label>
  <label class="check"><input type="checkbox" name="done" value="1"${values.done ? raw(" checked") : ""}> Done</label>
  <div class="form__actions">
    <button type="submit" class="button">Save</button>
    <a href="${back}" class="linkish">Cancel</a>
  </div>
</form>
<form method="post" action="/tasks/${task.id}/delete" class="inline-form" data-confirm="Delete the task “${task.title}”?">
  <button type="submit" class="button button--danger-quiet">Delete task</button>
</form>`,
  });
}
