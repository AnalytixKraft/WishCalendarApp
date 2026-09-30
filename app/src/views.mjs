/* Every page, as HTML strings. `html` escapes whatever it interpolates unless
 * it is already html (or raw()), so a name typed as <script> stays text. */

import { STATE_LABELS } from "./bridge.mjs";
import { MONTHS, WEEKDAYS, ageOn, formatBirthday, formatDayMonth, formatShortDate, weekdayOf, zonedNow } from "./dates.mjs";
import { DEFAULT_TEMPLATE, MAX_TEMPLATE, PLACEHOLDERS } from "./messages.mjs";

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
  ["groups", "/groups", "Groups"],
  ["whatsapp", "/whatsapp", "WhatsApp"],
  ["settings", "/settings", "Settings"],
];

export function layout({ title, active = null, body, flash = null, signedIn = true, assets }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · Birthday Reminder</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${assets.css}">
<script src="${assets.js}" defer></script>
</head>
<body>
${signedIn
  ? html`<header class="masthead">
  <a class="brand" href="/"><span class="brand__mark" aria-hidden="true"></span>Birthday Reminder</a>
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
  const names = people.map((p) => ({ name: p.name, age: ageOn(p, date) }));
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
          (n) => html`<li>${n.name}${n.age ? html` <span class="leaf__age">(${n.age})</span>` : ""}</li>`,
        )}</ul>`
      : size === "large"
        ? html`<p class="leaf__blank">No birthdays today</p>`
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
    <h1>Birthday Reminder</h1>
    <label class="field">
      <span class="field__label">Password</span>
      <input type="password" name="password" autocomplete="current-password" required autofocus>
    </label>
    ${error ? html`<p class="field__error" role="alert">${error}</p>` : ""}
    <button type="submit" class="button">Sign in</button>
    <p class="hint">The password is ADMIN_PASSWORD in the .env file on the computer that runs this app.</p>
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
  return html`<p class="status"><span class="dot dot--bad" aria-hidden="true"></span><span class="status__text">Not connected — ${STATE_LABELS[s.state] || s.state}. <a href="/whatsapp">${s.state === "idle" ? "Link a phone" : "Open the WhatsApp page"}</a></span></p>`;
}

export const phoneOf = (me) => (me?.id ? `+${me.id.split("@")[0].split(":")[0]}` : "");

function deliveryLine(job, timeZone) {
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
    ? html`Wish for <strong>${job.person.name}</strong> in ${job.chat.subject}`
    : html`Reminder in <strong>${job.chat.subject}</strong>`;
}

/* "12:21", or "30 Sep, 12:21" — in the app's time zone, spelled the way the
 * rest of the app spells dates. */
function clockTime(iso, timeZone, withDate = false) {
  const t = zonedNow(new Date(iso), timeZone);
  const time = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
  return withDate ? `${formatDayMonth(t)}, ${time}` : time;
}

export function todayPage({ today, settings, wa, agenda, upcoming, recent, last, counts, assets, flash }) {
  const todays = upcoming.filter((u) => u.inDays === 0).map((u) => u.person);
  const later = new Map();
  for (const u of upcoming.filter((u) => u.inDays > 0)) {
    const key = u.inDays;
    if (!later.has(key)) later.set(key, { date: u.date, inDays: u.inDays, people: [] });
    later.get(key).people.push(u.person);
  }

  const setupSteps = [
    [wa.status?.state === "open", html`<a href="/whatsapp">Link the WhatsApp number</a> that will post the messages`],
    [counts.chats > 0, html`<a href="/groups">Add the groups</a> to post in`],
    [counts.people > 0, html`<a href="/people/new">Add people</a>, or <a href="/people/import">import a list</a>`],
    [settings.enabled, html`<a href="/settings">Turn sending on</a>`],
  ];
  const setupDone = setupSteps.every(([done]) => done);

  return layout({
    title: "Today",
    active: "today",
    assets,
    flash,
    body: html`<h1 class="visually-hidden">Today</h1>
<div class="today">
  <section class="today__leaf" aria-label="Today’s birthdays">
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
        ? html`<p class="status"><span class="dot dot--ok" aria-hidden="true"></span><span class="status__text">On — reminder at ${settings.reminderTime}, wishes at ${settings.wishTime} <span class="muted">(${settings.timezone})</span></span></p>`
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
            (job) => html`<li class="job job--${job.delivery?.status || "due"}">
          <p class="job__title">${jobTitle(job)}</p>
          <p class="job__state">${deliveryLine(job, settings.timezone)}</p>
          ${job.delivery?.status === "failed"
            ? html`<form method="post" action="/retry" class="inline-form"><input type="hidden" name="key" value="${job.key}"><button type="submit" class="button button--small button--quiet">Retry now</button></form>`
            : ""}
        </li>`,
          )}</ul>`
        : html`<p class="empty">${counts.chats === 0
            ? html`Nothing to send: no groups yet. <a href="/groups">Add a group</a>`
            : "Nothing to send today — no birthdays, and nothing for the reminder to mention."}</p>`}
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
    : html`<p class="empty">No birthdays in the next 30 days.${counts.people === 0 ? html` <a href="/people/new">Add someone</a>` : ""}</p>`}
</section>

<section class="card">
  <h2>Recent messages</h2>
  ${recent.length
    ? html`<div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">When</th><th scope="col">Message</th><th scope="col">Group</th><th scope="col">Result</th></tr></thead>
    <tbody>${recent.map(
      (d) => html`<tr>
      <td class="nowrap">${clockTime(d.updated_at, settings.timezone, true)}</td>
      <td>${d.kind === "wish" ? `Wish for ${d.person_name}` : d.kind === "reminder" ? "Reminder" : "Test message"}</td>
      <td>${d.chat_subject}</td>
      <td>${d.status === "sent"
        ? html`<span class="tick tick--sent" aria-hidden="true">✓</span> Sent`
        : d.status === "sending"
          ? html`<span class="tick tick--sending" aria-hidden="true">…</span> Sending`
          : html`<span class="tick tick--failed" aria-hidden="true">✕</span> ${d.error}`}</td>
    </tr>`,
    )}</tbody>
  </table></div>`
    : html`<p class="empty">Nothing sent yet.</p>`}
</section>`,
  });
}

/* ----------------------------------------------------------------- people */

function nextLabel(u) {
  const age = ageOn(u.person, u.date);
  const turns = age ? ` · turns ${age}` : "";
  if (u.inDays === 0) return html`<span class="chip chip--today">Today${turns}</span>`;
  if (u.inDays === 1) return html`<span class="chip">Tomorrow${turns}</span>`;
  return html`<span class="next">${formatShortDate(u.date)} <span class="muted">· in ${u.inDays} days${turns}</span></span>`;
}

export function peoplePage({ rows, chatNames, assets, flash }) {
  const paused = rows.filter((r) => !r.person.active).length;
  return layout({
    title: "People",
    active: "people",
    assets,
    flash,
    body: html`<header class="page-head">
  <div>
    <h1>People</h1>
    <p class="lede">${rows.length ? `${plural(rows.length, "person", "people")} on the list${paused ? `, ${paused} paused` : ""}. Soonest birthday first.` : "No one on the list yet."}</p>
  </div>
  <div class="page-head__actions">
    <a class="button button--quiet" href="/people/import">Import a list</a>
    <a class="button" href="/people/new">Add person</a>
  </div>
</header>
${rows.length
  ? html`<div class="card card--flush">
  <div class="table-tools"><label class="visually-hidden" for="people-filter">Find by name</label><input id="people-filter" type="search" class="filter" placeholder="Find by name" data-filter="people-table" autocomplete="off"></div>
  <div class="table-wrap"><table class="table" id="people-table">
    <thead><tr><th scope="col">Name</th><th scope="col">Birthday</th><th scope="col">Next</th><th scope="col">Wished in</th></tr></thead>
    <tbody>${rows.map(
      (r) => html`<tr data-name="${r.person.name.toLowerCase()}" class="${r.person.active ? "" : "is-paused"}">
      <td><a href="/people/${r.person.id}">${r.person.name}</a>${r.person.active ? "" : html` <span class="chip chip--muted">Paused</span>`}</td>
      <td class="nowrap">${formatBirthday(r.person)}</td>
      <td>${nextLabel(r)}</td>
      <td>${r.chatIds.length
        ? r.chatIds.map((id) => chatNames.get(id)).filter(Boolean).sort((a, b) => a.localeCompare(b)).join(", ")
        : html`<span class="muted">No group — reminder only</span>`}</td>
    </tr>`,
    )}</tbody>
  </table></div>
  <p class="empty" data-filter-empty="people-table" hidden>No one by that name.</p>
</div>`
  : html`<div class="card empty-state">
  <p>Add people one at a time, or paste a list from a spreadsheet.</p>
  <p><a class="button" href="/people/new">Add person</a> <a class="button button--quiet" href="/people/import">Import a list</a></p>
</div>`}`,
  });
}

function selectOptions(options, selected) {
  return options.map(([value, label]) => html`<option value="${value}"${String(value) === String(selected) ? raw(" selected") : ""}>${label}</option>`);
}

export function personFormPage({ person, values, chats, selected, errors = {}, assets, flash }) {
  const editing = Boolean(person);
  // A blank first choice, so a birthday is never saved as whatever the
  // form happened to show.
  const days = [["", "—"], ...Array.from({ length: 31 }, (_, i) => [i + 1, i + 1])];
  const months = [["", "—"], ...MONTHS.map((m, i) => [i + 1, m])];
  return layout({
    title: editing ? person.name : "Add person",
    active: "people",
    assets,
    flash,
    body: html`<p class="crumbs"><a href="/people">People</a></p>
<h1>${editing ? person.name : "Add person"}</h1>
<form method="post" action="${editing ? `/people/${person.id}` : "/people"}" class="card form" novalidate>
  <label class="field">
    <span class="field__label">Name</span>
    <input name="name" value="${values.name}" maxlength="100" required autocomplete="off"${errors.name ? raw(' aria-invalid="true"') : ""}>
    ${errors.name ? html`<span class="field__error">${errors.name}</span>` : ""}
  </label>

  <fieldset class="field">
    <legend class="field__label">Birthday</legend>
    <div class="birthday">
      <label><span class="field__sublabel">Day</span><select name="day">${selectOptions(days, values.day)}</select></label>
      <label><span class="field__sublabel">Month</span><select name="month">${selectOptions(months, values.month)}</select></label>
      <label><span class="field__sublabel">Year <span class="optional">optional</span></span><input name="year" value="${values.year}" inputmode="numeric" maxlength="4" size="5" autocomplete="off"${errors.year ? raw(' aria-invalid="true"') : ""}></label>
    </div>
    ${errors.birthday ? html`<span class="field__error">${errors.birthday}</span>` : ""}
    ${errors.year ? html`<span class="field__error">${errors.year}</span>` : ""}
    <span class="hint">With the year, wishes and reminders can say the age they turn.</span>
  </fieldset>

  <fieldset class="field">
    <legend class="field__label">Wish them in</legend>
    ${chats.length
      ? chats.map(
          (c) => html`<label class="check"><input type="checkbox" name="chats" value="${c.id}"${selected.has(c.id) ? raw(" checked") : ""}> ${c.subject}${c.wishes ? "" : html` <span class="muted">— wishes are off in this group</span>`}</label>`,
        )
      : html`<p class="hint">No groups yet. <a href="/groups">Add a group</a> first, or save now and pick groups later.</p>`}
  </fieldset>

  <label class="field">
    <span class="field__label">Notes <span class="optional">optional</span></span>
    <textarea name="notes" rows="2" maxlength="500">${values.notes}</textarea>
  </label>

  <label class="check"><input type="checkbox" name="active" value="1"${values.active ? raw(" checked") : ""}> Include in wishes and reminders</label>

  <div class="form__actions">
    <button type="submit" class="button">${editing ? "Save changes" : "Add person"}</button>
    <a href="/people" class="linkish">Cancel</a>
  </div>
</form>
${editing
  ? html`<form method="post" action="/people/${person.id}/delete" class="danger-zone" data-confirm="Remove ${person.name} from the list? Their wish history stays in Recent messages.">
  <button type="submit" class="button button--danger">Remove from the list</button>
</form>`
  : ""}`,
  });
}

export function importPage({ result = null, text = "", chats, assets, flash }) {
  const wishGroups = chats.filter((c) => c.wishes).map((c) => c.subject);
  return layout({
    title: "Import a list",
    active: "people",
    assets,
    flash,
    body: html`<p class="crumbs"><a href="/people">People</a></p>
<h1>Import a list</h1>
${result
  ? html`<section class="card result">
  <p><strong>${plural(result.added, "person", "people")} added.</strong>${result.duplicates ? ` ${plural(result.duplicates, "was", "were")} already on the list and ${result.duplicates === 1 ? "was" : "were"} skipped.` : ""}</p>
  ${result.errors.length
    ? html`<p>${plural(result.errors.length, "line")} need${result.errors.length === 1 ? "s" : ""} fixing — they were not imported:</p>
  <ul class="problems">${result.errors.map((e) => html`<li>${e.line ? `Line ${e.line}: ` : ""}${e.message}</li>`)}</ul>`
    : ""}
  ${result.warnings.length ? html`<ul class="problems problems--soft">${result.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ""}
  <p><a href="/people">See the list</a></p>
</section>`
  : ""}
<form method="post" action="/people/import" class="card form">
  <p>Paste rows from a spreadsheet, or the text of a CSV file — one person per line: <strong>name</strong>, <strong>birthday</strong>, and if you like <strong>groups</strong> and <strong>notes</strong>. A header row is fine.</p>
  <pre class="example">Name	Birthday	Groups
Anu Joseph	30-09-1996	St. Mary's Youth
Biju Thomas	5 Oct</pre>
  <label class="field">
    <span class="field__label">List</span>
    <textarea name="list" rows="12" required spellcheck="false">${text}</textarea>
  </label>
  <ul class="hint-list">
    <li>Birthdays are read <strong>day first</strong>: 30-09-1996, 30/09, 30.9, 30 Sep, 1996-09-30. The year can be left out.</li>
    <li>Groups are group names from the Groups page, separated by <code>;</code>. Left empty, the person is wished in ${wishGroups.length ? `every group that has wishes on (${wishGroups.join(", ")})` : "no group yet — add groups first to have them wished"}.</li>
    <li>Someone with the same name and birthday as a person already on the list is skipped.</li>
  </ul>
  <div class="form__actions"><button type="submit" class="button">Import people</button></div>
</form>`,
  });
}

/* ----------------------------------------------------------------- groups */

function placeholderHelp() {
  return html`<details class="placeholders"><summary>What can go in a message</summary>
  <dl>${PLACEHOLDERS.map(([token, meaning]) => html`<dt><code>${token}</code></dt><dd>${meaning}</dd>`)}</dl>
  <p class="hint">WhatsApp formatting works too: *bold*, _italic_.</p>
</details>`;
}

export function groupsPage({ chats, counts, available, wa, sample, defaultTemplate, assets, flash }) {
  const sampleData = JSON.stringify(sample.data);
  return layout({
    title: "Groups",
    active: "groups",
    assets,
    flash,
    body: html`<header class="page-head">
  <div>
    <h1>Groups</h1>
    <p class="lede">Birthday wishes and your reminder are posted in these WhatsApp groups. The linked number has to be a member of each one.</p>
  </div>
</header>

${chats.length
  ? chats.map(
      (c) => html`<article class="card group" id="group-${c.id}">
  <header class="group__head">
    <h2>${c.subject}</h2>
    <p class="muted">${c.wishes ? `${plural(counts.get(c.id) || 0, "person", "people")} wished here` : "Wishes off"}${c.reminders ? " · gets your reminder" : ""}</p>
  </header>
  <form method="post" action="/groups/update" class="form">
    <input type="hidden" name="id" value="${c.id}">
    <label class="check"><input type="checkbox" name="wishes" value="1" data-shows="wish-${c.id}"${c.wishes ? raw(" checked") : ""}> Post birthday wishes here</label>
    <label class="check"><input type="checkbox" name="reminders" value="1"${c.reminders ? raw(" checked") : ""}> Post my daily reminder here</label>
    <div class="form" id="wish-${c.id}"${c.wishes ? "" : raw(" hidden")}>
      <label class="field">
        <span class="field__label">Wish message <span class="optional">empty uses the default from Settings</span></span>
        <textarea name="template" rows="4" maxlength="${MAX_TEMPLATE}" placeholder="${defaultTemplate}" data-preview="preview-${c.id}">${c.template}</textarea>
      </label>
      <div class="preview">
        <p class="eyebrow">Preview, for ${sample.label}</p>
        <div class="bubble" id="preview-${c.id}" data-sample="${sampleData}" data-group="${c.subject}" data-default="${defaultTemplate}">${whatsappFormat(sample.render(c))}</div>
      </div>
      ${placeholderHelp()}
    </div>
    <div class="form__actions"><button type="submit" class="button">Save changes</button></div>
  </form>
  <div class="group__more">
    ${c.wishes
      ? html`<form method="post" action="/groups/everyone" class="inline-form" data-confirm="Wish everyone on the list in ${c.subject}?">
      <input type="hidden" name="id" value="${c.id}"><button type="submit" class="button button--quiet button--small">Wish everyone on the list here</button>
    </form>`
      : ""}
    <form method="post" action="/groups/test" class="inline-form" data-confirm="Post a short test message in ${c.subject}? Everyone in the group will see it.">
      <input type="hidden" name="id" value="${c.id}"><button type="submit" class="button button--quiet button--small">Send a test message</button>
    </form>
    <form method="post" action="/groups/remove" class="inline-form" data-confirm="Stop posting in ${c.subject}? The number stays in the group on WhatsApp.">
      <input type="hidden" name="id" value="${c.id}"><button type="submit" class="button button--danger-quiet button--small">Remove</button>
    </form>
  </div>
</article>`,
    )
  : html`<div class="card empty-state"><p>No groups yet. Add one from the list below.</p></div>`}

<section class="card">
  <h2>Add a group</h2>
  ${available === null
    ? html`<p>${wa.error || "WhatsApp is not connected."} Link a number on the <a href="/whatsapp">WhatsApp page</a> to see the groups it is in.</p>`
    : available.length
      ? html`<ul class="pick">${available.map(
          (g) => html`<li>
        <div><strong>${g.subject || "(no name)"}</strong> <span class="muted">${plural(g.participants, "member")}${g.announce ? (g.is_admin ? " · only admins send; the number is an admin" : " · only admins can send — make the number an admin first") : ""}</span></div>
        <form method="post" action="/groups/add" class="inline-form pick__actions">
          <input type="hidden" name="id" value="${g.id}"><input type="hidden" name="subject" value="${g.subject}">
          <button type="submit" name="purpose" value="wishes" class="button button--small">Add for wishes</button>
          <button type="submit" name="purpose" value="reminders" class="button button--small button--quiet">Add for my reminder</button>
        </form>
      </li>`,
        )}</ul>`
      : html`<p>Every group the linked number is in has been added. To post somewhere else, add the number to that group on WhatsApp first.</p>`}
  <p class="hint">For a private reminder, create a WhatsApp group with just you and the linked number, then add it here with “Add for my reminder”.</p>
</section>`,
  });
}

/* --------------------------------------------------------------- whatsapp */

export function whatsappPage({ status, error, assets, flash }) {
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
<p class="hint">The code changes every 20 seconds, and stops after about 3 minutes. This page follows along on its own.</p>`;
  } else if (state === "connecting") {
    body = html`<p class="status"><span class="dot dot--off" aria-hidden="true"></span><span class="status__text">Connecting${status.me ? html` as <strong>${status.me.name || phoneOf(status.me)}</strong>` : ""}…</span></p>
${status.last_error ? html`<p class="notice">${status.last_error}</p>` : ""}
<p class="hint">This page refreshes on its own. If it stays here for long, check this computer’s internet connection.</p>
<form method="post" action="/whatsapp/logout" class="inline-form" data-confirm="Unlink this WhatsApp number?"><button type="submit" class="button button--quiet">Unlink</button></form>`;
  } else if (state === "conflict") {
    body = html`<p class="status"><span class="dot dot--bad" aria-hidden="true"></span><span class="status__text">Another WhatsApp Web session took over this link.</span></p>
<p class="notice">${status.last_error}</p>
<form method="post" action="/whatsapp/logout" class="inline-form" data-confirm="Unlink, so you can link the phone again?"><button type="submit" class="button">Unlink</button></form>`;
  } else {
    body = html`<p>Link the WhatsApp number that will post the wishes and your reminder.</p>
<div class="warning">
  <p><strong>Use a spare number, not your personal or business one.</strong> WhatsApp does not allow unofficial apps like this one, and can ban the number that uses one — with every chat on it.</p>
</div>
${status?.last_error ? html`<p class="notice">${status.last_error}</p>` : ""}
<form method="post" action="/whatsapp/pair" class="inline-form"><button type="submit" class="button">Link a phone</button></form>`;
  }
  return layout({
    title: "WhatsApp",
    active: "whatsapp",
    assets,
    flash,
    body: html`<h1>WhatsApp</h1>
<section class="card whatsapp" data-wa-state="${state}">
  ${body}
</section>`,
  });
}

/* --------------------------------------------------------------- settings */

export function settingsPage({ values, errors = {}, timeZones, assets, flash }) {
  return layout({
    title: "Settings",
    active: "settings",
    assets,
    flash,
    body: html`<h1>Settings</h1>
<form method="post" action="/settings" class="card form" novalidate>
  <label class="check check--big"><input type="checkbox" name="enabled" value="1"${values.enabled ? raw(" checked") : ""}> <span><strong>Send messages</strong><br><span class="hint">Off, nothing goes out on its own — Send now on the Today page still works.</span></span></label>

  <div class="field-row">
    <label class="field">
      <span class="field__label">Reminder at</span>
      <input type="time" name="reminderTime" value="${values.reminderTime}" required${errors.reminderTime ? raw(' aria-invalid="true"') : ""}>
      ${errors.reminderTime ? html`<span class="field__error">${errors.reminderTime}</span>` : ""}
    </label>
    <label class="field">
      <span class="field__label">Wishes at</span>
      <input type="time" name="wishTime" value="${values.wishTime}" required${errors.wishTime ? raw(' aria-invalid="true"') : ""}>
      ${errors.wishTime ? html`<span class="field__error">${errors.wishTime}</span>` : ""}
    </label>
    <label class="field">
      <span class="field__label">Time zone</span>
      <select name="timezone">${selectOptions(timeZones.map((z) => [z, z.replaceAll("_", " ")]), values.timezone)}</select>
    </label>
  </div>
  <p class="hint">If this computer is off or asleep at those times, the day’s messages go out when it is back — later that day, never twice.</p>

  <label class="field field--short">
    <span class="field__label">Days ahead in the reminder</span>
    <input type="number" name="daysAhead" value="${values.daysAhead}" min="0" max="30" required${errors.daysAhead ? raw(' aria-invalid="true"') : ""}>
    ${errors.daysAhead ? html`<span class="field__error">${errors.daysAhead}</span>` : ""}
    <span class="hint">The reminder lists today’s birthdays and the ones this many days ahead. 0 lists today only.</span>
  </label>

  <label class="field">
    <span class="field__label">Default wish message</span>
    <textarea name="template" rows="5" maxlength="${MAX_TEMPLATE}" placeholder="${DEFAULT_TEMPLATE}">${values.template}</textarea>
    ${errors.template ? html`<span class="field__error">${errors.template}</span>` : ""}
    <span class="hint">Used in every group that has no message of its own. Empty restores the original.</span>
  </label>
  ${placeholderHelp()}

  <div class="form__actions"><button type="submit" class="button">Save changes</button></div>
</form>`,
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
