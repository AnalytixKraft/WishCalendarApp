/* Every page, as HTML strings. `html` escapes whatever it interpolates unless
 * it is already html (or raw()), so a name typed as <script> stays text. */

import { MAX_PASSWORD, MIN_PASSWORD } from "./auth.mjs";
import { STATE_LABELS } from "./bridge.mjs";
import { MONTHS, WEEKDAYS, ageOn, formatBirthday, formatDayMonth, formatShortDate, weekdayOf, zonedNow } from "./dates.mjs";
import {
  DEFAULT_ANNIVERSARY_TEMPLATE,
  DEFAULT_TEMPLATE,
  KIND_ICON,
  KIND_LABEL,
  MAX_TEMPLATE,
  PLACEHOLDERS,
  alertSummary,
  occasionNote,
} from "./messages.mjs";

const iconOf = (kind) => KIND_ICON[kind] ?? KIND_ICON.birthday;

/* A default message made this person's, to edit for them: their name in
 * place of {name} and {first_name}. {years}, {ordinal} and {group} stay, so
 * a message saved from it is still right next year, and after a change of
 * group. app.js does the same when the occasion changes. */
function personalize(template, name) {
  if (!name) return template;
  return template.replaceAll("{name}", name).replaceAll("{first_name}", name.trim().split(/\s+/)[0]);
}
const occasionWord = (kind) => (kind === "anniversary" ? "anniversary" : "birthday");

class Html {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function render(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escape(value);
}

export const raw = (value) => new Html(String(value));

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

/* What the app is called on its pages. (Inside, it keeps its first name —
 * the Docker project, the volumes, the cookie — so a rename loses nothing.) */
export const APP_NAME = "Wish Calendar";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* A message as WhatsApp shows it: *bold*, _italic_, ~strike~. Escaped first,
 * so the markup added here is the only markup. app.js does the same for the
 * live preview. */
export function whatsappFormat(text) {
  return raw(
    escape(text)
      .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/gm, "$1<em>$2</em>")
      .replace(/~([^~\n]+)~/g, "<s>$1</s>"),
  );
}

/* ------------------------------------------------------------------ frame */

const NAV = [
  ["today", "/", "Today"],
  ["people", "/people", "People"],
  ["settings", "/settings", "Settings"],
];

export function layout({ title, active = null, body, flash = null, signedIn = true, assets }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · ${APP_NAME}</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${assets.css}">
<script src="${assets.js}" defer></script>
</head>
<body>
${signedIn
  ? html`<header class="masthead">
  <a class="brand" href="/"><span class="brand__mark" aria-hidden="true"></span>${APP_NAME}</a>
  <nav class="nav" aria-label="Main">
    ${NAV.map(([key, href, label]) => html`<a href="${href}"${key === active ? raw(' aria-current="page"') : ""}>${label}</a>`)}
  </nav>
  <form method="post" action="/logout" class="masthead__signout"><button type="submit" class="linkish">Sign out</button></form>
</header>`
  : ""}
<main class="page${signedIn ? "" : " page--bare"}">
${flash ? html`<div class="flash flash--${flash.type}" role="${flash.type === "error" ? "alert" : "status"}">${flash.text}</div>` : ""}
${body}
</main>
</body>
</html>`;
}

/* ------------------------------------------------------------- the leaf */

/* A page of a tear-off wall calendar: the day's numeral (red on Sundays, as
 * printed calendars do), and the names written on it in pen. `heading` is
 * the level its (visually hidden) title takes in the page's outline. */
function leaf({ date, size, people = [], caption = null, heading = "h3" }) {
  const weekday = WEEKDAYS[weekdayOf(date)];
  const sunday = weekdayOf(date) === 0;
  const names = people.map((p) => ({ name: p.name, kind: p.kind, years: ageOn(p, date) }));
  const title = `${weekday} ${date.day} ${MONTHS[date.month - 1]}${caption ? `, ${caption}` : ""}`;
  return html`<article class="leaf leaf--${size}${sunday ? " leaf--sunday" : ""}">
  <div class="leaf__binding" aria-hidden="true"></div>
  <div class="leaf__paper">
    ${raw(`<${heading} class="visually-hidden">`)}${title}${raw(`</${heading}>`)}
    <p class="leaf__month" aria-hidden="true">${size === "large" ? `${MONTHS[date.month - 1]} ${date.year}` : MONTHS[date.month - 1].slice(0, 3)}</p>
    <p class="leaf__day" aria-hidden="true">${date.day}</p>
    <p class="leaf__weekday" aria-hidden="true">${size === "large" ? weekday : weekday.slice(0, 3)}</p>
    ${names.length
      ? html`<ul class="leaf__names">${names.map(
          (n) => html`<li><span aria-hidden="true">${iconOf(n.kind)}</span> ${n.name}${n.years ? html` <span class="leaf__age">(${n.kind === "anniversary" ? `${n.years} yrs` : n.years})</span>` : ""}<span class="visually-hidden">, ${occasionWord(n.kind)}</span></li>`,
        )}</ul>`
      : size === "large"
        ? html`<p class="leaf__blank">No birthdays or anniversaries today</p>`
        : ""}
  </div>
</article>`;
}

/* --------------------------------------------------------- sign in, setup */

export function signInPage({ today, error, assets }) {
  return layout({
    title: "Sign in",
    signedIn: false,
    assets,
    body: html`<div class="signin">
  ${leaf({ date: today, size: "small", heading: "p" })}
  <form method="post" action="/login" class="card signin__form">
    <h1>${APP_NAME}</h1>
    <label class="field">
      <span class="field__label">Password</span>
      <input type="password" name="password" autocomplete="current-password" required autofocus>
    </label>
    ${error ? html`<p class="field__error" role="alert">${error}</p>` : ""}
    <button type="submit" class="button">Sign in</button>
    <p class="hint">First time: the password is ADMIN_PASSWORD in the .env file on the computer that runs this app. Forgot a password set in Settings? Run <code>bash scripts/reset-password.sh</code> there.</p>
  </form>
</div>`,
  });
}

export function notConfiguredPage({ problems, assets }) {
  return layout({
    title: "Setup needed",
    signedIn: false,
    assets,
    body: html`<div class="card narrow">
  <h1>Finish the setup</h1>
  <p>This app will not open until these are fixed in the .env file:</p>
  <ul class="problems">${problems.map((p) => html`<li>${p}</li>`)}</ul>
  <p>From the project folder, run <code>bash scripts/setup.sh</code>, then <code>docker compose up -d</code>.</p>
</div>`,
  });
}

/* ------------------------------------------------------------------ today */

function waSummary(wa) {
  if (wa.error) return html`<p class="status"><span class="dot dot--bad" aria-hidden="true"></span><span class="status__text">${wa.error}</span></p>`;
  const s = wa.status;
  if (s.state === "open") {
    return html`<p class="status"><span class="dot dot--ok" aria-hidden="true"></span><span class="status__text">Connected as <strong>${s.me?.name || phoneOf(s.me)}</strong>${s.me?.name ? html` <span class="muted">${phoneOf(s.me)}</span>` : ""}</span></p>`;
  }
  return html`<p class="status"><span class="dot dot--bad" aria-hidden="true"></span><span class="status__text">Not connected — ${STATE_LABELS[s.state] || s.state}. <a href="/settings#whatsapp">${s.state === "idle" ? "Link a phone" : "See Settings"}</a></span></p>`;
}

export const phoneOf = (me) => (me?.id ? `+${me.id.split("@")[0].split(":")[0]}` : "");

function deliveryLine(job, timeZone) {
  if (!job.to) {
    return html`<span class="tick tick--failed" aria-hidden="true">!</span><span>Won’t be sent — no “Send to” chosen. <a href="/people/${job.person.id}">Choose one</a></span>`;
  }
  const d = job.delivery;
  if (d?.status === "sent") return html`<span class="tick tick--sent" aria-hidden="true">✓</span><span>Sent at ${clockTime(d.updated_at, timeZone)}</span>`;
  if (d?.status === "sending") return html`<span class="tick tick--sending" aria-hidden="true">…</span><span>Sending</span>`;
  if (d?.status === "failed") {
    return html`<span class="tick tick--failed" aria-hidden="true">✕</span><span>Not sent (${plural(d.attempts, "try", "tries")}): ${d.error}</span>`;
  }
  return html`<span class="tick tick--due" aria-hidden="true">◷</span><span>${job.due ? "Due now" : `Goes out at ${job.time}`}</span>`;
}

function jobTitle(job) {
  return job.kind === "wish"
    ? html`<span aria-hidden="true">${iconOf(job.person.kind)}</span> Wish for <strong>${job.person.name}</strong>${job.to ? html` <span class="arrow" aria-hidden="true">→</span><span class="visually-hidden">, to</span> ${job.to.label}` : ""}`
    : html`Your reminder <span class="arrow" aria-hidden="true">→</span><span class="visually-hidden">, to</span> ${job.to.label}`;
}

/* "12:21", or "30 Sep, 12:21" — in the app's time zone, spelled the way the
 * rest of the app spells dates. */
function clockTime(iso, timeZone, withDate = false) {
  const t = zonedNow(new Date(iso), timeZone);
  const time = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
  return withDate ? `${formatDayMonth(t)}, ${time}` : time;
}

/* What a row of Recent messages was. */
function recentTitle(d) {
  switch (d.kind) {
    case "wish":
      return `Wish for ${d.person_name}`;
    case "reminder":
      return "Your reminder";
    case "alert":
      return `Alert: ${alertSummary(d.text)}`;
    default:
      return `Preview of ${d.person_name ?? "a wish"}`;
  }
}

function recentResult(d) {
  switch (d.status) {
    case "sent":
      return html`<span class="tick tick--sent" aria-hidden="true">✓</span> Sent`;
    case "sending":
      return html`<span class="tick tick--sending" aria-hidden="true">…</span> Sending`;
    case "pending":
      return html`<span class="tick tick--due" aria-hidden="true">◷</span> Waiting to be sent`;
    default:
      return html`<span class="tick tick--failed" aria-hidden="true">✕</span> ${d.error}`;
  }
}

export function todayPage({ today, settings, reminderLabel, alertLabel, wa, agenda, upcoming, recent, last, counts, assets, flash }) {
  const todays = upcoming.filter((u) => u.inDays === 0).map((u) => u.person);
  const later = new Map();
  for (const u of upcoming.filter((u) => u.inDays > 0)) {
    const key = u.inDays;
    if (!later.has(key)) later.set(key, { date: u.date, inDays: u.inDays, people: [] });
    later.get(key).people.push(u.person);
  }

  const setupSteps = [
    [wa.status?.state === "open", html`<a href="/settings#whatsapp">Link the WhatsApp number</a> that will send the messages`],
    [counts.people > 0, html`<a href="/people/import">Upload your list</a>, or <a href="/people/new">add people</a> one by one`],
    [
      counts.people > 0 && counts.unassigned === 0,
      html`<a href="/people">Choose where each wish goes</a>${counts.people && counts.unassigned ? ` — ${plural(counts.unassigned, "person has", "people have")} no “Send to” yet` : ""}`,
    ],
    [settings.enabled, html`<a href="/settings">Turn sending on</a>, and choose where your reminder goes`],
  ];
  const setupDone = setupSteps.every(([done]) => done);

  return layout({
    title: "Today",
    active: "today",
    assets,
    flash,
    body: html`<h1 class="visually-hidden">Today</h1>
<div class="today">
  <section class="today__leaf" aria-label="Today’s birthdays and anniversaries">
    ${leaf({ date: today, size: "large", people: todays, heading: "h2" })}
  </section>

  <div class="today__side">
    ${setupDone
      ? ""
      : html`<section class="card setup">
      <h2>Getting started</h2>
      <ol class="setup__steps">
        ${setupSteps.map(([done, text]) => html`<li class="${done ? "is-done" : ""}"><span class="setup__mark" aria-hidden="true">${done ? "✓" : ""}</span><span>${text}${done ? html`<span class="visually-hidden"> (done)</span>` : ""}</span></li>`)}
      </ol>
    </section>`}

    <section class="card">
      <h2 class="eyebrow">WhatsApp</h2>
      ${waSummary(wa)}
      <h2 class="eyebrow">Sending</h2>
      ${settings.enabled
        ? html`<p class="status"><span class="dot dot--ok" aria-hidden="true"></span><span class="status__text">On — wishes at ${settings.wishTime}, ${reminderLabel ? `your reminder at ${settings.reminderTime} to ${reminderLabel}` : "no reminder"}, ${alertLabel ? `alerts to ${alertLabel}` : "no alerts"} <span class="muted">(${settings.timezone})</span></span></p>`
        : html`<p class="status"><span class="dot dot--off" aria-hidden="true"></span><span class="status__text">Paused — nothing goes out on its own. <a href="/settings">Turn sending on</a></span></p>`}
      ${last.waiting ? html`<p class="notice">Messages are waiting: ${last.waiting}</p>` : ""}
      <form method="post" action="/run" class="inline-form" data-confirm="Send every message for today that has not gone out yet, now?">
        <button type="submit" class="button">Send today’s messages now</button>
      </form>
    </section>

    <section class="card">
      <h2>Today’s messages</h2>
      ${agenda.length
        ? html`<ul class="jobs">${agenda.map(
            (job) => html`<li class="job job--${!job.to ? "failed" : job.delivery?.status || "due"}">
          <p class="job__title">${jobTitle(job)}</p>
          <p class="job__state">${deliveryLine(job, settings.timezone)}</p>
          ${job.to && job.delivery?.status === "failed"
            ? html`<form method="post" action="/retry" class="inline-form"><input type="hidden" name="key" value="${job.key}"><button type="submit" class="button button--small button--quiet">Retry now</button></form>`
            : ""}
        </li>`,
          )}</ul>`
        : html`<p class="empty">Nothing to send today — no birthdays${reminderLabel ? ", and nothing for the reminder to mention" : ""}.</p>`}
    </section>
  </div>
</div>

<section class="upcoming" aria-labelledby="upcoming-title">
  <h2 id="upcoming-title">Coming up <span class="muted">· next 30 days</span></h2>
  ${later.size
    ? html`<ol class="leaves">${[...later.values()].map((d) => {
        const when = d.inDays === 1 ? "Tomorrow" : `In ${d.inDays} days`;
        return html`<li>${leaf({ date: d.date, size: "small", people: d.people, caption: when })}<p class="leaves__when" aria-hidden="true">${when}</p></li>`;
      })}</ol>`
    : html`<p class="empty">No birthdays in the next 30 days.${counts.people === 0 ? html` <a href="/people/import">Upload your list</a>` : ""}</p>`}
</section>

<section class="card">
  <h2>Recent messages</h2>
  ${recent.length
    ? html`<div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">When</th><th scope="col">Message</th><th scope="col">To</th><th scope="col">Result</th></tr></thead>
    <tbody>${recent.map(
      (d) => html`<tr>
      <td class="nowrap">${clockTime(d.updated_at, settings.timezone, true)}</td>
      <td>${recentTitle(d)}</td>
      <td>${d.chat_subject || "—"}</td>
      <td>${recentResult(d)}</td>
    </tr>`,
    )}</tbody>
  </table></div>`
    : html`<p class="empty">Nothing sent yet.</p>`}
</section>`,
  });
}

/* ----------------------------------------------------------------- people */

function nextLabel(u) {
  const note = occasionNote(u.person, u.date);
  const extra = note ? ` · ${note}` : "";
  if (u.inDays === 0) return html`<span class="chip chip--today">Today${extra}</span>`;
  if (u.inDays === 1) return html`<span class="chip">Tomorrow${extra}</span>`;
  return html`<span class="next">${formatShortDate(u.date)} <span class="muted">· in ${u.inDays} days${extra}</span></span>`;
}

/* The default messages, editable where the rows use them (People) — the
 * same two as on the Settings page. */
function defaultsEditor(defaults, { open = false } = {}) {
  return html`<details class="card defaults" id="default-messages"${open ? raw(" open") : ""}>
  <summary><strong>Default messages</strong> <span class="muted">— sent for every row whose own message is empty</span></summary>
  <form method="post" action="/settings/messages" class="form defaults__form">
    <div class="defaults__pair">
      <label class="field">
        <span class="field__label">${iconOf("birthday")} Birthday</span>
        <textarea name="template" rows="5" maxlength="${MAX_TEMPLATE}" placeholder="${DEFAULT_TEMPLATE}">${defaults.birthday}</textarea>
      </label>
      <label class="field">
        <span class="field__label">${iconOf("anniversary")} Anniversary</span>
        <textarea name="anniversaryTemplate" rows="5" maxlength="${MAX_TEMPLATE}" placeholder="${DEFAULT_ANNIVERSARY_TEMPLATE}">${defaults.anniversary}</textarea>
      </label>
    </div>
    ${placeholderHelp()}
    <div class="form__actions"><button type="submit" class="button">Save default messages</button><span class="hint">Empty restores the original.</span></div>
  </form>
</details>`;
}

/* The "Send wish to" choices: nothing yet, the person's own number, or one
 * of the groups the linked number is in. A group chosen earlier that the
 * number has since left stays listed, so a save does not silently drop it. */
export function sendToOptions(selected, groups, { direct = "Their number (direct message)", none = "— choose —", self = null } = {}) {
  const known = new Set(groups.map((g) => g.id));
  const stale = selected && !["direct", "self"].includes(selected) && !known.has(selected);
  const opt = (value, label) => html`<option value="${value}"${value === selected ? raw(" selected") : ""}>${label}</option>`;
  return html`${opt("", none)}${self ? opt("self", self) : ""}${opt("direct", direct)}${groups.length || stale
    ? html`<optgroup label="Groups">${groups.map((g) => opt(g.id, g.subject))}${stale ? opt(selected, "A group the number has left") : ""}</optgroup>`
    : ""}`;
}

export function peoplePage({ rows, groups, groupsNote, values, errors = new Map(), wishTime, defaults, assets, flash }) {
  const unassigned = rows.filter((r) => r.person.active && !r.person.sendTo).length;
  const paused = rows.filter((r) => !r.person.active).length;
  const anniversaries = rows.filter((r) => r.person.kind === "anniversary").length;
  const birthdays = rows.length - anniversaries;
  const defaultFor = (kind) => (kind === "anniversary" ? defaults.anniversary : defaults.birthday);
  const invalid = (e) => (e ? raw(' aria-invalid="true"') : "");
  return layout({
    title: "People",
    active: "people",
    assets,
    flash,
    body: html`<header class="page-head">
  <div>
    <h1>People</h1>
    <p class="lede">${rows.length
      ? html`${plural(birthdays, "birthday")} and ${plural(anniversaries, "anniversary", "anniversaries")} on the list${paused ? `, ${paused} paused` : ""}${unassigned ? html` — <strong>${plural(unassigned, "has", "have")} no “Send to” yet</strong>` : ""}. For each, choose where the wish goes, when, and what it says, then save.`
      : "No one on the list yet."}</p>
  </div>
  <div class="page-head__actions">
    <a class="button button--quiet" href="/people/import">Upload a list</a>
    <a class="button button--quiet" href="/people/new?kind=anniversary">Add anniversary</a>
    <a class="button" href="/people/new">Add birthday</a>
  </div>
</header>
${defaultsEditor(defaults, { open: defaults.open || !rows.length })}
${rows.length
  ? html`${groupsNote ? html`<p class="notice">${groupsNote}</p>` : ""}
<form method="post" action="/people/save" class="card card--flush people-form" novalidate>
  <div class="table-tools">
    <label class="visually-hidden" for="people-filter">Find by name</label>
    <input id="people-filter" type="search" class="filter" placeholder="Find by name" data-filter="people-table" autocomplete="off">
  </div>
  <div class="table-wrap">
  <table class="table people" id="people-table">
    <thead><tr><th scope="col">Person</th><th scope="col">WhatsApp number</th><th scope="col">Send wish to</th><th scope="col">Time <span class="th-note">empty: ${wishTime}</span></th><th scope="col">Message</th></tr></thead>
    <tbody>${rows.map((r) => {
      const p = r.person;
      const v = values.get(p.id);
      const e = errors.get(p.id) || {};
      const sendNowConfirm =
        r.inDays === 0
          ? `Send ${p.name}’s ${occasionWord(p.kind)} wish now? The table is saved first; the wish goes where their row says, and not again at its time today.`
          : `Send ${p.name}’s ${occasionWord(p.kind)} wish now? The table is saved first. It is not their ${occasionWord(p.kind)} today — the wish on ${formatDayMonth(r.date)} still goes out as planned.`;
      return html`<tr data-name="${p.name.toLowerCase()}" class="${[p.active ? "" : "is-paused", e.phone || e.sendTo || e.sendTime ? "is-invalid" : ""].join(" ").trim()}">
      <td class="people__who">
        <input type="hidden" name="id" value="${p.id}">
        <a href="/people/${p.id}">${p.name}</a>${p.active ? "" : html` <span class="chip chip--muted">Paused</span>`}
        <span class="people__when"><span aria-hidden="true">${iconOf(p.kind)}</span><span class="visually-hidden">${KIND_LABEL[p.kind] ?? "Birthday"}:</span> ${formatBirthday(p)} · ${nextLabel(r)}</span>
        <span class="people__actions">
          <button type="submit" name="send" value="${p.id}" class="button button--quiet button--small" data-confirm="${sendNowConfirm}">Send now</button>
          <button type="submit" name="delete" value="${p.id}" class="button button--danger-quiet button--small" data-confirm="Delete ${p.name}’s ${occasionWord(p.kind)} (${formatBirthday(p)}) from the list? Their wish won’t be sent. Other changes in the table are saved first.">Delete</button>
        </span>
      </td>
      <td data-label="WhatsApp number">
        <input name="phone_${p.id}" value="${v.phone}" inputmode="tel" autocomplete="off" placeholder="+91 98765 43210" aria-label="WhatsApp number for ${p.name}"${invalid(e.phone)}>
        ${e.phone ? html`<span class="field__error">${e.phone}</span>` : ""}
      </td>
      <td data-label="Send wish to">
        <select name="send_to_${p.id}" aria-label="Where ${p.name}’s wish goes"${invalid(e.sendTo)}>${sendToOptions(v.sendTo, groups)}</select>
        ${e.sendTo ? html`<span class="field__error">${e.sendTo}</span>` : ""}
      </td>
      <td data-label="Time">
        <input type="time" name="time_${p.id}" value="${v.sendTime}" aria-label="Time ${p.name}’s wish goes out (empty: ${wishTime})"${invalid(e.sendTime)}>
        ${e.sendTime ? html`<span class="field__error">${e.sendTime}</span>` : ""}
      </td>
      <td data-label="Message">
        <textarea name="message_${p.id}" rows="2" maxlength="${MAX_TEMPLATE}" placeholder="${personalize(defaultFor(p.kind), p.name)}" data-default-message="${personalize(defaultFor(p.kind), p.name)}" aria-label="Message for ${p.name}’s ${occasionWord(p.kind)}">${v.message}</textarea>
      </td>
    </tr>`;
    })}</tbody>
  </table>
  </div>
  <p class="empty" data-filter-empty="people-table" hidden>No one by that name.</p>
  <div class="people-form__actions">
    <button type="submit" class="button">Save changes</button>
    <span class="hint">An empty message sends the default (above). Click into one to start from the default with their name in, and change it for them. An empty time is ${wishTime}.</span>
  </div>
</form>`
  : html`<div class="card empty-state">
  <p>Upload your list — a CSV file, or rows pasted from a spreadsheet — or add birthdays and anniversaries one at a time.</p>
  <p><a class="button" href="/people/import">Upload a list</a> <a class="button button--quiet" href="/people/new">Add birthday</a> <a class="button button--quiet" href="/people/new?kind=anniversary">Add anniversary</a></p>
</div>`}`,
  });
}

function selectOptions(options, selected) {
  return options.map(([value, label]) => html`<option value="${value}"${String(value) === String(selected) ? raw(" selected") : ""}>${label}</option>`);
}

function placeholderHelp() {
  return html`<details class="placeholders"><summary>What can go in a message</summary>
  <dl>${PLACEHOLDERS.map(([token, meaning]) => html`<dt><code>${token}</code></dt><dd>${meaning}</dd>`)}</dl>
  <p class="hint">WhatsApp formatting works too: *bold*, _italic_.</p>
</details>`;
}

export function personFormPage({ person, values, groups, errors = {}, preview, birthdayToday, wishTime, previewTo, assets, flash }) {
  const kind = values.kind === "anniversary" ? "anniversary" : "birthday";
  const checked = (on) => (on ? raw(" checked") : "");
  const editing = Boolean(person);
  // A blank first choice, so a birthday is never saved as whatever the
  // form happened to show.
  const days = [["", "—"], ...Array.from({ length: 31 }, (_, i) => [i + 1, i + 1])];
  const months = [["", "—"], ...MONTHS.map((m, i) => [i + 1, m])];
  const invalid = (e) => (e ? raw(' aria-invalid="true"') : "");
  return layout({
    title: editing ? person.name : kind === "anniversary" ? "Add anniversary" : "Add birthday",
    active: "people",
    assets,
    flash,
    body: html`<p class="crumbs"><a href="/people">People</a></p>
<h1>${editing ? person.name : kind === "anniversary" ? "Add anniversary" : "Add birthday"}</h1>
<form method="post" action="${editing ? `/people/${person.id}` : "/people"}" class="card form" novalidate>
  <fieldset class="field">
    <legend class="field__label">Occasion</legend>
    <div class="kinds">
      <label class="check"><input type="radio" name="kind" value="birthday" data-kind-for="wish-preview"${checked(kind === "birthday")}> ${iconOf("birthday")} Birthday</label>
      <label class="check"><input type="radio" name="kind" value="anniversary" data-kind-for="wish-preview"${checked(kind === "anniversary")}> ${iconOf("anniversary")} Anniversary</label>
    </div>
  </fieldset>

  <label class="field">
    <span class="field__label">Name <span class="optional">for an anniversary, the couple — like Joseph &amp; Mary</span></span>
    <input name="name" value="${values.name}" maxlength="100" required autocomplete="off"${invalid(errors.name)}>
    ${errors.name ? html`<span class="field__error">${errors.name}</span>` : ""}
  </label>

  <fieldset class="field">
    <legend class="field__label">Date <span class="optional">the birthday, or the wedding day</span></legend>
    <div class="birthday">
      <label><span class="field__sublabel">Day</span><select name="day">${selectOptions(days, values.day)}</select></label>
      <label><span class="field__sublabel">Month</span><select name="month">${selectOptions(months, values.month)}</select></label>
      <label><span class="field__sublabel">Year <span class="optional">optional</span></span><input name="year" value="${values.year}" inputmode="numeric" maxlength="4" size="5" autocomplete="off"${invalid(errors.year)}></label>
    </div>
    ${errors.birthday ? html`<span class="field__error">${errors.birthday}</span>` : ""}
    ${errors.year ? html`<span class="field__error">${errors.year}</span>` : ""}
    <span class="hint">With the year, messages can say the age they turn, or the years married.</span>
  </fieldset>

  <div class="field-row">
    <label class="field">
      <span class="field__label">WhatsApp number <span class="optional">for a direct message</span></span>
      <input name="phone" value="${values.phone}" inputmode="tel" autocomplete="off" placeholder="+91 98765 43210"${invalid(errors.phone)}>
      ${errors.phone ? html`<span class="field__error">${errors.phone}</span>` : ""}
    </label>
    <label class="field">
      <span class="field__label">Send wish to</span>
      <select name="sendTo" data-group-for="wish-preview"${invalid(errors.sendTo)}>${sendToOptions(values.sendTo, groups)}</select>
      ${errors.sendTo ? html`<span class="field__error">${errors.sendTo}</span>` : ""}
    </label>
    <label class="field">
      <span class="field__label">Time <span class="optional">empty: ${wishTime}</span></span>
      <input type="time" name="sendTime" value="${values.sendTime}"${invalid(errors.sendTime)}>
      ${errors.sendTime ? html`<span class="field__error">${errors.sendTime}</span>` : ""}
    </label>
  </div>

  <label class="field">
    <span class="field__label">Message <span class="optional">empty uses the default from Settings</span></span>
    <textarea name="message" rows="4" maxlength="${MAX_TEMPLATE}" placeholder="${personalize(preview.defaultTemplate, values.name)}" data-default-message="${personalize(preview.defaultTemplate, values.name)}" data-default-template="${preview.defaultTemplate}" data-preview="wish-preview">${values.message}</textarea>
    <span class="hint">Empty sends the default for its occasion. Click in to start from it, with their name in, and change it for them. <a href="/people?defaults#default-messages">Edit the default messages</a></span>
  </label>
  <div class="preview">
    <p class="eyebrow">Preview</p>
    <div class="bubble" id="wish-preview" data-sample="${JSON.stringify(preview.sample)}" data-group="${preview.groupName}" data-default="${preview.defaultTemplate}" data-default-birthday="${preview.defaults.birthday}" data-default-anniversary="${preview.defaults.anniversary}">${whatsappFormat(preview.text)}</div>
  </div>
  ${placeholderHelp()}

  <label class="field">
    <span class="field__label">Notes <span class="optional">optional, never sent</span></span>
    <textarea name="notes" rows="2" maxlength="500">${values.notes}</textarea>
  </label>

  <label class="check"><input type="checkbox" name="active" value="1"${values.active ? raw(" checked") : ""}> Include in wishes and reminders</label>

  <div class="form__actions">
    <button type="submit" class="button">${editing ? "Save changes" : "Add person"}</button>
    <a href="/people" class="linkish">Cancel</a>
  </div>
</form>
${editing
  ? html`<div class="person-extras">
  <form method="post" action="/people/${person.id}/send" class="inline-form" data-confirm="${birthdayToday
    ? `Send ${person.name}’s ${occasionWord(person.kind)} wish now? It won’t go again at its time today.`
    : `Send ${person.name}’s ${occasionWord(person.kind)} wish now? It is not their ${occasionWord(person.kind)} today — the wish on the day still goes out as planned.`}">
    <button type="submit" class="button">Send now</button>
  </form>
  <form method="post" action="/people/${person.id}/preview" class="inline-form" data-confirm="Send a preview of ${person.name}’s wish to ${previewTo}?">
    <button type="submit" class="button button--quiet">Send me a preview</button>
  </form>
  <span class="hint">Both send the saved message. A preview goes to ${previewTo}.</span>
  <form method="post" action="/people/${person.id}/delete" class="inline-form person-extras__remove" data-confirm="Delete ${person.name}’s ${occasionWord(person.kind)} from the list? Their wish won’t be sent. What was sent before stays in Recent messages.">
    <button type="submit" class="button button--danger">Delete from the list</button>
  </form>
</div>`
  : ""}`,
  });
}

export function importPage({ result = null, text = "", countryCode, assets, flash }) {
  return layout({
    title: "Upload a list",
    active: "people",
    assets,
    flash,
    body: html`<p class="crumbs"><a href="/people">People</a></p>
<h1>Upload a list</h1>
${result
  ? html`<section class="card result">
  <p><strong>Added ${plural(result.added.birthday, "birthday")} and ${plural(result.added.anniversary, "anniversary", "anniversaries")}.</strong>${result.duplicates ? ` ${result.duplicates} already on the list ${result.duplicates === 1 ? "was" : "were"} skipped.` : ""}</p>
  ${result.errors.length
    ? html`<p>${plural(result.errors.length, "line was", "lines were")} not added:</p>
  <ul class="problems">${result.errors.map((e) => html`<li>${e.line ? `Line ${e.line}: ` : ""}${e.message}</li>`)}</ul>`
    : ""}
  ${result.warnings.length
    ? html`<p>Added, with a detail left for you to fill in:</p><ul class="problems problems--soft">${result.warnings.map((w) => html`<li>${w}</li>`)}</ul>`
    : ""}
  ${result.added.birthday + result.added.anniversary ? html`<p><a class="button" href="/people">Choose where each wish goes</a></p>` : ""}
</section>`
  : ""}
<form method="post" action="/people/import" class="card form">
  <p>Upload a CSV file, or paste rows copied from Excel or Google Sheets — one person per row. A header row is fine, and the columns can be in any order:</p>
  <pre class="example">Name	Birthday	Anniversary	WhatsApp number	Send to	Message
Anu Joseph	30-09-1996		98765 43210	direct	Happy birthday, Anu! 🎂
Joseph &amp; Mary		15-05-1995		St. Mary's Youth
Biju Thomas	5 Oct	12 Jan			</pre>
  <label class="field" data-file-field hidden>
    <span class="field__label">CSV file</span>
    <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" data-file-into="list">
  </label>
  <label class="field">
    <span class="field__label">The list</span>
    <textarea id="list" name="list" rows="12" required spellcheck="false">${text}</textarea>
  </label>
  <ul class="hint-list">
    <li>Only a <strong>name</strong> and a date are needed: a <strong>Birthday</strong>, an <strong>Anniversary</strong> (the wedding day), or both — a row with both adds both. A list with one <strong>Date</strong> column can say which in an <strong>Occasion</strong> column.</li>
    <li>Dates are read <strong>day first</strong>: 30-09-1996, 30/09, 30.9, 30 Sep, 1996-09-30 — the year can be left out.</li>
    <li><strong>WhatsApp number</strong>: numbers without a country code get +${countryCode}.</li>
    <li><strong>Send to</strong>: a group’s name, or <code>direct</code> for their own number. Leave it empty to choose on the People page.</li>
    <li><strong>Message</strong>: what the wish says — on a row with both dates, the birthday’s (an <strong>Anniversary message</strong> column is the anniversary’s). Leave it empty for the default.</li>
    <li><strong>Time</strong> (optional): when their wish goes out, like 09:30. Leave it empty for the wish time in Settings.</li>
    <li>A birthday or anniversary already on the list (same name, occasion and date) is skipped.</li>
  </ul>
  <div class="form__actions"><button type="submit" class="button">Add these people</button></div>
</form>`,
  });
}

/* ------------------------------------------------- whatsapp, in Settings */

/* The linked phone: its state, Link or Unlink, and the QR code while
 * linking (app.js follows it along). */
function whatsappSection({ status, error }) {
  const state = status?.state ?? "unreachable";
  let body;
  if (error) {
    body = html`<p class="status"><span class="dot dot--bad" aria-hidden="true"></span><span class="status__text">${error}</span></p>`;
  } else if (state === "open") {
    body = html`<p class="status"><span class="dot dot--ok" aria-hidden="true"></span><span class="status__text">Connected as <strong>${status.me?.name || phoneOf(status.me)}</strong> <span class="muted">${phoneOf(status.me)}</span></span></p>
<p>Keep that phone on, and open WhatsApp on it at least once every two weeks — otherwise WhatsApp unlinks this computer.</p>
<form method="post" action="/whatsapp/logout" class="inline-form" data-confirm="Unlink this WhatsApp number? Nothing is sent until a phone is linked again.">
  <button type="submit" class="button button--danger">Unlink</button>
</form>`;
  } else if (state === "pairing") {
    body = html`<div class="pairing">
  <figure class="qr">
    ${status.qr ? html`<img src="/whatsapp/qr.svg?t=${encodeURIComponent(status.qr_expires_at || "")}" width="264" height="264" alt="QR code for linking WhatsApp" data-qr>` : html`<div class="qr__wait" data-qr>Asking WhatsApp for a code…</div>`}
  </figure>
  <ol class="steps">
    <li>On the phone with the number to link, open WhatsApp.</li>
    <li>Go to <strong>Settings → Linked devices</strong> and tap <strong>Link a device</strong>.</li>
    <li>Point the phone at this code.</li>
  </ol>
</div>
<p class="hint">The code changes every 20 seconds, and stops after about 3 minutes. This section follows along on its own.</p>`;
  } else if (state === "connecting") {
    body = html`<p class="status"><span class="dot dot--off" aria-hidden="true"></span><span class="status__text">Connecting${status.me ? html` as <strong>${status.me.name || phoneOf(status.me)}</strong>` : ""}…</span></p>
${status.last_error ? html`<p class="notice">${status.last_error}</p>` : ""}
<p class="hint">This section follows along on its own. If it stays here for long, check this computer’s internet connection.</p>
<form method="post" action="/whatsapp/logout" class="inline-form" data-confirm="Unlink this WhatsApp number?"><button type="submit" class="button button--quiet">Unlink</button></form>`;
  } else if (state === "conflict") {
    body = html`<p class="status"><span class="dot dot--bad" aria-hidden="true"></span><span class="status__text">Another WhatsApp Web session took over this link.</span></p>
<p class="notice">${status.last_error}</p>
<form method="post" action="/whatsapp/logout" class="inline-form" data-confirm="Unlink, so you can link the phone again?"><button type="submit" class="button">Unlink</button></form>`;
  } else {
    body = html`<p>Link the WhatsApp number that will send the wishes and your reminder.</p>
<div class="warning">
  <p><strong>Use a spare number, not your personal or business one.</strong> WhatsApp does not allow unofficial apps like this one, and can ban the number that uses one — with every chat on it. Messaging people directly draws more attention than posting in groups.</p>
</div>
${status?.last_error ? html`<p class="notice">${status.last_error}</p>` : ""}
<form method="post" action="/whatsapp/pair" class="inline-form"><button type="submit" class="button">Link a phone</button></form>`;
  }
  return html`<section class="card whatsapp" id="whatsapp" data-wa-state="${state}" aria-labelledby="whatsapp-title">
  <h2 class="settings-title" id="whatsapp-title">WhatsApp</h2>
  ${body}
  <p class="wa-changed notice" hidden>WhatsApp’s state has changed — <a href="/settings#whatsapp">reload</a> to see it (your unsaved settings below would be lost).</p>
</section>`;
}

/* --------------------------------------------------------------- settings */

export function settingsPage({ values, errors = {}, timeZones, groups, wa, assets, flash }) {
  const invalid = (e) => (e ? raw(' aria-invalid="true"') : "");
  const error = (e) => (e ? html`<span class="field__error">${e}</span>` : "");
  return layout({
    title: "Settings",
    active: "settings",
    assets,
    flash,
    body: html`<h1>Settings</h1>
${whatsappSection(wa)}
<form method="post" action="/settings" class="card form" novalidate>
  <h2 class="settings-title">Messages</h2>
  <label class="check check--big"><input type="checkbox" name="enabled" value="1"${values.enabled ? raw(" checked") : ""}> <span><strong>Send wishes and reminders automatically</strong><br><span class="hint">Ticked, each goes out at its time. Unticked, the app pauses: nothing goes out on its own — no wishes, reminders or alerts — until you tick it again. The Send now buttons work either way.</span></span></label>

  <fieldset class="settings-group">
    <legend>Wishes</legend>
    <label class="field field--short">
      <span class="field__label">Wishes at</span>
      <input type="time" name="wishTime" value="${values.wishTime}" required${invalid(errors.wishTime)}>
      ${error(errors.wishTime)}
    </label>
    <div class="defaults__pair">
      <label class="field">
        <span class="field__label">${iconOf("birthday")} Default birthday message</span>
        <textarea name="template" rows="5" maxlength="${MAX_TEMPLATE}" placeholder="${DEFAULT_TEMPLATE}">${values.template}</textarea>
        ${error(errors.template)}
      </label>
      <label class="field">
        <span class="field__label">${iconOf("anniversary")} Default anniversary message</span>
        <textarea name="anniversaryTemplate" rows="5" maxlength="${MAX_TEMPLATE}" placeholder="${DEFAULT_ANNIVERSARY_TEMPLATE}">${values.anniversaryTemplate}</textarea>
        ${error(errors.anniversaryTemplate)}
      </label>
    </div>
    <span class="hint">Sent for every row whose own message on the People page is empty. Empty here restores the original.</span>
    ${placeholderHelp()}
  </fieldset>

  <fieldset class="settings-group">
    <legend>Your reminder</legend>
    <div class="field-row">
      <label class="field">
        <span class="field__label">Your WhatsApp number</span>
        <input name="myPhone" value="${values.myPhone}" inputmode="tel" autocomplete="off" placeholder="+91 98765 43210"${invalid(errors.myPhone)}>
        ${error(errors.myPhone)}
      </label>
      <label class="field">
        <span class="field__label">Send my daily reminder to</span>
        <select name="reminderTo"${invalid(errors.reminderTo)}>${sendToOptions(values.reminderTo, groups, { self: "This WhatsApp — the linked phone", direct: "My number (below)", none: "Nowhere — no reminder" })}</select>
        ${error(errors.reminderTo)}
      </label>
    </div>
    <div class="field-row">
      <label class="field">
        <span class="field__label">Reminder at</span>
        <input type="time" name="reminderTime" value="${values.reminderTime}" required${invalid(errors.reminderTime)}>
        ${error(errors.reminderTime)}
      </label>
      <label class="field">
        <span class="field__label">Days ahead</span>
        <input type="number" name="daysAhead" value="${values.daysAhead}" min="0" max="30" required${invalid(errors.daysAhead)}>
        ${error(errors.daysAhead)}
      </label>
    </div>
    <p class="hint">Before the wishes go out, the reminder lists every wish of the day — its time, where it goes, what it says — and the birthdays and anniversaries this many days ahead. “This WhatsApp” puts it in the linked phone’s own chat (Message yourself). Previews go to your number, or to the linked phone if you leave it empty.</p>
  </fieldset>

  <fieldset class="settings-group" id="alerts">
    <legend>Alerts</legend>
    <label class="field field--short">
      <span class="field__label">When a wish is not sent, tell</span>
      <select name="alertTo"${invalid(errors.alertTo)}>${sendToOptions(values.alertTo, groups, { self: "This WhatsApp — the linked phone", direct: "My number (above)", none: "No one — no alerts" })}</select>
      ${error(errors.alertTo)}
    </label>
    <p class="hint">An alert says which wish was not sent, and why: as soon as WhatsApp refuses one, or the next morning, at the reminder time, when a day ended while this computer was off or asleep or WhatsApp was not connected. While WhatsApp is not connected, alerts wait for it too. They come from the linked number, so sent to that number itself they land in Message yourself without a notification; in a group, everyone there sees them.</p>
    <div class="form__actions">
      <button type="submit" form="test-alert" class="button button--quiet button--small" data-confirm="Send a test alert now, to where alerts go as last saved?">Send a test alert</button>
      <span class="hint">Goes where alerts go, as last saved.</span>
    </div>
  </fieldset>

  <fieldset class="settings-group">
    <legend>Time and numbers</legend>
    <div class="field-row">
      <label class="field">
        <span class="field__label">Time zone</span>
        <select name="timezone">${selectOptions(timeZones.map((z) => [z, z.replaceAll("_", " ")]), values.timezone)}</select>
      </label>
      <label class="field">
        <span class="field__label">Country code for numbers without one</span>
        <input name="countryCode" value="${values.countryCode}" inputmode="numeric" maxlength="4" autocomplete="off"${invalid(errors.countryCode)}>
        ${error(errors.countryCode)}
      </label>
    </div>
    <p class="hint">If this computer is off or asleep at the set times, the day’s messages go out when it is back — later that day, never twice.</p>
  </fieldset>

  <div class="form__actions"><button type="submit" class="button">Save changes</button></div>
</form>
<form method="post" action="/settings/test-alert" id="test-alert" hidden></form>

<section class="card" id="password" aria-labelledby="password-title">
  <h2 class="settings-title" id="password-title">Password</h2>
  <form method="post" action="/settings/password" class="form">
    <div class="field-row">
      <label class="field">
        <span class="field__label">Current password</span>
        <input type="password" name="current" autocomplete="current-password" required>
      </label>
      <label class="field">
        <span class="field__label">New password <span class="optional">${MIN_PASSWORD}+ characters</span></span>
        <input type="password" name="next" autocomplete="new-password" minlength="${MIN_PASSWORD}" maxlength="${MAX_PASSWORD}" required>
      </label>
      <label class="field">
        <span class="field__label">New password again</span>
        <input type="password" name="again" autocomplete="new-password" minlength="${MIN_PASSWORD}" maxlength="${MAX_PASSWORD}" required>
      </label>
    </div>
    <div class="form__actions"><button type="submit" class="button">Change password</button></div>
    <p class="hint">Changing it signs out every other browser. Forgot it? On the computer that runs the app, run <code>bash scripts/reset-password.sh</code> — then sign in with ADMIN_PASSWORD from its .env file.</p>
  </form>
</section>`,
  });
}

export function errorPage({ status, message, assets, signedIn = true }) {
  return layout({
    title: status === 404 ? "Not found" : "Something went wrong",
    assets,
    signedIn,
    body: html`<div class="card narrow"><h1>${status === 404 ? "Not found" : "Something went wrong"}</h1><p>${message}</p><p><a href="/">Back to today</a></p></div>`,
  });
}
