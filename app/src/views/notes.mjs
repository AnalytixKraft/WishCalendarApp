/* The notebook: notes, a note's own page and its form, the journal, and the
 * pieces of it that show on Today and on a person's page. */

import { MONTHS, WEEKDAYS, addDays, formatShortDate, fromIsoDate, isoDate, weekdayOf } from "../dates.mjs";
import { MAX_BODY, MAX_TITLE, TAG_PATTERN, URL_PATTERN, normalizeTag, trimUrl } from "../notes.mjs";
import { escape, formatMarks, html, plural, raw } from "./html.mjs";
import { clockTime, iconOf, layout, leaf } from "./layout.mjs";

const tagHref = (tag) => `/notes?tag=${encodeURIComponent(tag)}`;

/* Text that is not a link: #tags become links to their notes, and *bold*,
 * _italic_ and ~strike~ work as in WhatsApp. Escaped first. */
function formatText(text) {
  return formatMarks(
    escape(text).replace(TAG_PATTERN, (_, before, tag) => `${before}<a class="tag" href="${escape(tagHref(normalizeTag(tag)))}">#${tag}</a>`),
  );
}

/* A note's text as html: links open in a new tab, the rest as formatText.
 * Line breaks are kept by the stylesheet (white-space: pre-wrap). */
export function noteText(text) {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(m[0]);
    out += formatText(text.slice(last, m.index));
    out += `<a href="${escape(url)}" rel="noopener noreferrer" target="_blank">${escape(url)}</a>`;
    last = m.index + url.length;
  }
  return raw(out + formatText(text.slice(last)));
}

/* A search snippet: the words found marked, everything else as text. */
const marked = (snippet) => raw(escape(snippet).replaceAll("\u0001", "<mark>").replaceAll("\u0002", "</mark>"));

const oneLine = (text) => text.replace(/\s+/g, " ").trim();
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

export const longDate = (date) => `${WEEKDAYS[weekdayOf(date)]} ${date.day} ${MONTHS[date.month - 1]} ${date.year}`;

/* What a note is called, and the text that goes under that. A note without
 * a title is called by its first line (all of it stays in the text when it
 * is too long to be a title). */
function headline(n) {
  if (n.kind === "journal") return { title: `Journal · ${formatShortDate(fromIsoDate(n.day))} ${n.day.slice(0, 4)}`, rest: n.preview ?? "" };
  const text = n.preview ?? n.body ?? "";
  if (n.title) return { title: n.title, rest: text };
  const [first = "", ...more] = text.trim().split("\n");
  const line = oneLine(first);
  return line.length <= 80 ? { title: line || "Untitled", rest: more.join("\n") } : { title: clip(line, 80), rest: text };
}

const hrefOf = (n) => (n.kind === "journal" ? `/journal/${n.day}` : `/notes/${n.id}`);

function tagLinks(tags) {
  return tags.map((t) => html`<a class="tag" href="${tagHref(t)}">#${t}</a> `);
}

function noteCard(n, timeZone) {
  const { title, rest } = headline(n);
  const text = n.snippet ? marked(oneLine(n.snippet)) : raw(formatMarks(escape(oneLine(rest))));
  return html`<li class="note-card${n.pinned ? " is-pinned" : ""}${n.kind === "journal" ? " note-card--journal" : ""}">
  <h3 class="note-card__title"><a href="${hrefOf(n)}">${title}</a></h3>
  ${n.snippet || rest.trim() ? html`<p class="note-card__text">${text}</p>` : ""}
  <p class="note-card__meta">${n.pinned ? html`<span class="note-card__pin">Pinned</span> · ` : ""}${n.person
    ? html`<span aria-hidden="true">${iconOf(n.person.kind)}</span> ${n.person.name} · `
    : ""}${tagLinks(n.tags)}<span class="nowrap">${clockTime(n.updatedAt, timeZone, true)}</span></p>
</li>`;
}

/* ------------------------------------------------------------------ notes */

export function notesPage({ notes, results, query, tag, tags, counts, more, timeZone, assets, flash }) {
  const filtering = query || tag;
  let list;
  if (query) {
    list = results.length
      ? html`<h2 class="notes__heading">${plural(results.length, "match", "matches")} for “${query}”</h2><ul class="notes">${results.map((n) => noteCard(n, timeZone))}</ul>`
      : html`<p class="empty">Nothing found for “${query}”. Search looks for words that start the way you typed them, in notes and in the journal.</p>`;
  } else if (tag) {
    list = notes.length
      ? html`<h2 class="notes__heading">#${tag} <span class="muted">· ${plural(notes.length, "note")}</span></h2><ul class="notes">${notes.map((n) => noteCard(n, timeZone))}</ul>`
      : html`<p class="empty">Nothing is tagged #${tag} any more.</p>`;
  } else {
    list = notes.length
      ? html`<ul class="notes">${notes.map((n) => noteCard(n, timeZone))}</ul>${more ? html`<p class="hint">These are the ${notes.length} latest. Search to find older ones.</p>` : ""}`
      : html`<div class="card empty-state">
  <p>Nothing written yet. A note can be anything — a thought, a list, gift ideas for someone on your list.</p>
  <p><a class="button" href="/notes/new">Write a note</a> <a class="button button--quiet" href="/journal">Open today’s journal page</a></p>
</div>`;
  }
  return layout({
    title: "Notes",
    active: "notes",
    assets,
    flash,
    body: html`<header class="page-head">
  <div>
    <h1>Notes</h1>
    <p class="lede">${counts.notes || counts.journal
      ? `${plural(counts.notes, "note")}, and ${plural(counts.journal, "journal page")}.`
      : "Your notebook: notes, and a journal page for each day."}</p>
  </div>
  <div class="page-head__actions">
    <a class="button button--quiet" href="/journal">Journal</a>
    <a class="button" href="/notes/new">New note</a>
  </div>
</header>
<form method="get" action="/notes" class="notes-search" role="search">
  <label class="visually-hidden" for="notes-q">Search notes and the journal</label>
  <input id="notes-q" type="search" name="q" value="${query}" placeholder="Search notes" autocomplete="off">
  <button type="submit" class="button button--quiet">Search</button>
  ${filtering ? html`<a href="/notes" class="linkish">Show all</a>` : ""}
</form>
${tags.length
  ? html`<p class="tags" aria-label="Tags">${tags.slice(0, 40).map(
      (t) => html`<a class="tag${t.tag === tag ? " is-current" : ""}" href="${tagHref(t.tag)}"${t.tag === tag ? raw(' aria-current="true"') : ""}>#${t.tag} <span class="tag__count">${t.count}</span></a> `,
    )}</p>`
  : ""}
${list}`,
  });
}

export function notePage({ note, timeZone, assets, flash }) {
  const { title, rest } = headline(note);
  const edited = note.updatedAt !== note.createdAt;
  return layout({
    title,
    active: "notes",
    assets,
    flash,
    body: html`<p class="crumbs"><a href="/notes">Notes</a></p>
<article class="card note">
  <h1 class="note__title">${title}</h1>
  <p class="note__meta">${note.person
    ? html`About <a href="/people/${note.person.id}">${note.person.name}</a> <span aria-hidden="true">${iconOf(note.person.kind)}</span> · `
    : ""}Written ${clockTime(note.createdAt, timeZone, true)}${edited ? `, edited ${clockTime(note.updatedAt, timeZone, true)}` : ""}${note.pinned ? " · Pinned" : ""}</p>
  ${rest.trim() ? html`<div class="note__body">${noteText(rest.replace(/^\n+/, ""))}</div>` : ""}
</article>
<div class="note-actions">
  <a class="button" href="/notes/${note.id}/edit">Edit</a>
  <form method="post" action="/notes/${note.id}/pin" class="inline-form">
    <input type="hidden" name="pinned" value="${note.pinned ? "0" : "1"}">
    <button type="submit" class="button button--quiet">${note.pinned ? "Unpin" : "Pin to the top"}</button>
  </form>
  <form method="post" action="/notes/${note.id}/delete" class="inline-form note-actions__remove" data-confirm="Delete “${title}”? It cannot be brought back.">
    <button type="submit" class="button button--danger-quiet">Delete</button>
  </form>
</div>`,
  });
}

export function noteFormPage({ note = null, values, errors = {}, people, assets, flash }) {
  const invalid = (e) => (e ? raw(' aria-invalid="true"') : "");
  const heading = note ? "Edit note" : "New note";
  const cancel = note ? `/notes/${note.id}` : "/notes";
  const option = (value, label) => html`<option value="${value}"${String(value) === String(values.personId ?? "") ? raw(" selected") : ""}>${label}</option>`;
  return layout({
    title: heading,
    active: "notes",
    assets,
    flash,
    body: html`<p class="crumbs"><a href="${cancel}">${note ? headline(note).title : "Notes"}</a></p>
<h1>${heading}</h1>
<form method="post" action="${note ? `/notes/${note.id}` : "/notes"}" class="card form" data-unsaved novalidate>
  <label class="field">
    <span class="field__label">Title <span class="optional">optional — without one, the first line is the title</span></span>
    <input name="title" value="${values.title}" maxlength="${MAX_TITLE}" autocomplete="off"${invalid(errors.title)}>
    ${errors.title ? html`<span class="field__error">${errors.title}</span>` : ""}
  </label>
  <label class="field">
    <span class="field__label">Note</span>
    <textarea name="body" rows="14" maxlength="${MAX_BODY}" class="note-input"${note ? "" : raw(" autofocus")}${invalid(errors.body)}>${values.body}</textarea>
    ${errors.body ? html`<span class="field__error">${errors.body}</span>` : ""}
    <span class="hint">*bold*, _italic_ and links work. Put #tags anywhere — #gifts, #health — to find notes by them. ⌘ or Ctrl + Enter saves.</span>
  </label>
  <div class="field-row">
    <label class="field">
      <span class="field__label">About <span class="optional">someone on your list</span></span>
      <select name="person">${option("", "— no one —")}${people.map((p) => option(p.id, `${iconOf(p.kind)} ${p.name}`))}</select>
    </label>
  </div>
  <label class="check"><input type="checkbox" name="pinned" value="1"${values.pinned ? raw(" checked") : ""}> Pin to the top of Notes</label>
  <div class="form__actions">
    <button type="submit" class="button">${note ? "Save changes" : "Save note"}</button>
    <a href="${cancel}" class="linkish">Cancel</a>
  </div>
</form>`,
  });
}

/* ---------------------------------------------------------------- journal */

/* The day's journal page, on Today. */
export function journalCard({ date, page }) {
  return html`<section class="card journal-card" aria-labelledby="journal-card-title">
  <h2 id="journal-card-title">Today’s page</h2>
  <form method="post" action="/journal/${isoDate(date)}" class="form journal-card__form" data-unsaved>
    <input type="hidden" name="back" value="today">
    <label class="visually-hidden" for="journal-today">Today’s journal page</label>
    <textarea id="journal-today" name="body" rows="4" maxlength="${MAX_BODY}" class="ruled" placeholder="A few lines about today. #tags work here too.">${page?.body ?? ""}</textarea>
    <div class="form__actions">
      <button type="submit" class="button button--small">Save</button>
      <a href="/journal/${isoDate(date)}">Open in the journal</a>
    </div>
  </form>
</section>`;
}

export function journalPage({ date, today, page, recent, people, timeZone, assets, flash }) {
  const day = isoDate(date);
  const isToday = day === isoDate(today);
  const prev = addDays(date, -1);
  const next = addDays(date, 1);
  return layout({
    title: `Journal · ${formatShortDate(date)}`,
    active: "notes",
    assets,
    flash,
    body: html`<p class="crumbs"><a href="/notes">Notes</a></p>
<header class="page-head">
  <div>
    <h1>Journal</h1>
    <p class="lede">${longDate(date)}${isToday ? " — today" : ""}</p>
  </div>
  <nav class="day-nav" aria-label="Other days">
    <a class="button button--quiet button--small" href="/journal/${isoDate(prev)}" rel="prev"><span aria-hidden="true">←</span> ${formatShortDate(prev)}</a>
    ${isToday ? "" : html`<a class="button button--quiet button--small" href="/journal/${isoDate(today)}">Today</a>`}
    <a class="button button--quiet button--small" href="/journal/${isoDate(next)}" rel="next">${formatShortDate(next)} <span aria-hidden="true">→</span></a>
  </nav>
</header>
<div class="journal">
  <div class="journal__leaf">${leaf({ date, size: "small", people, heading: "h2" })}</div>
  <form method="post" action="/journal/${day}" class="card form journal__page" data-unsaved>
    <label class="visually-hidden" for="journal-body">The page for ${longDate(date)}</label>
    <textarea id="journal-body" name="body" rows="16" maxlength="${MAX_BODY}" class="ruled"${isToday && !page ? raw(" autofocus") : ""} placeholder="${isToday ? "How is today going?" : "Nothing written on this day."}">${page?.body ?? ""}</textarea>
    <div class="form__actions">
      <button type="submit" class="button">Save page</button>
      <span class="hint">${page ? `Saved ${clockTime(page.updatedAt, timeZone, true)}. ` : ""}#tags and *bold* work. Saved empty, the page is gone.</span>
    </div>
  </form>
  <aside class="journal__pages" aria-labelledby="journal-pages-title">
    <h2 id="journal-pages-title" class="eyebrow">Latest pages</h2>
    ${recent.length
      ? html`<ul>${recent.map(
          (p) => html`<li${p.day === day ? raw(' aria-current="page"') : ""}><a href="/journal/${p.day}">${formatShortDate(fromIsoDate(p.day))}${p.day.slice(0, 4) === String(today.year) ? "" : ` ${p.day.slice(0, 4)}`}</a><span class="muted">${clip(oneLine(p.preview ?? ""), 70)}</span></li>`,
        )}</ul>`
      : html`<p class="empty">None yet.</p>`}
  </aside>
</div>
${page?.tags.length ? html`<p class="tags">${tagLinks(page.tags)}</p>` : ""}`,
  });
}

/* ------------------------------------------------- on a person's page */

export function personNotes({ person, notes }) {
  return html`<section class="card person-notes" aria-labelledby="person-notes-title">
  <h2 id="person-notes-title">Notes about ${person.name}</h2>
  ${notes.length
    ? html`<ul class="person-notes__list">${notes.map(
        (n) => html`<li><a href="/notes/${n.id}">${headline(n).title}</a>${n.pinned ? html` <span class="chip chip--muted">Pinned</span>` : ""}</li>`,
      )}</ul>`
    : html`<p class="empty">None yet — gift ideas, what they’re up to, what to ask them next time.</p>`}
  <p><a class="button button--quiet button--small" href="/notes/new?person=${person.id}">Add a note about ${person.name}</a></p>
</section>`;
}
