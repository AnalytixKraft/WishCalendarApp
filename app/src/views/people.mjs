/* People: the table of birthdays and anniversaries, a person's own page,
 * and uploading a list. */

import { MONTHS, formatBirthday, formatDayMonth, formatShortDate } from "../dates.mjs";
import { DEFAULT_ANNIVERSARY_TEMPLATE, DEFAULT_TEMPLATE, KIND_LABEL, MAX_TEMPLATE, PLACEHOLDERS, occasionNote } from "../messages.mjs";
import { html, plural, raw, selectOptions, whatsappFormat } from "./html.mjs";
import { iconOf, layout, occasionWord } from "./layout.mjs";

/* A default message made this person's, to edit for them: their name in
 * place of {name} and {first_name}. {years}, {ordinal} and {group} stay, so
 * a message saved from it is still right next year, and after a change of
 * group. app.js does the same when the occasion changes. */
function personalize(template, name) {
  if (!name) return template;
  return template.replaceAll("{name}", name).replaceAll("{first_name}", name.trim().split(/\s+/)[0]);
}

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

export function placeholderHelp() {
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
