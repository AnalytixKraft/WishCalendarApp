/* The notebook: notes (list, search, tags, a note's page, its form) and the
 * journal, a page a day. Nothing here sends anything. */

import { addDays, formatShortDate, fromIsoDate, isBirthdayOn, isoDate } from "../dates.mjs";
import { HttpError, readForm, redirect } from "../http.mjs";
import { IS_TAG, MAX_BODY, MAX_TITLE, normalizeTag, searchQuery } from "../notes.mjs";
import { journalPage, noteFormPage, notePage, notesPage } from "../views/notes.mjs";

const LIST_LIMIT = 200;
/* A note posts its whole text: 100 000 characters, at up to 4 bytes each,
 * percent-encoded. */
const MAX_FORM = 1_500_000;

/* 'YYYY-MM-DD' that is a real day → {year, month, day}; else null. */
function readDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = fromIsoDate(value);
  return date.year >= 1900 && date.year <= 2100 && isoDate(addDays(date, 0)) === value ? date : null;
}

const readText = (form, name) => form.raw(name).replace(/\r\n?/g, "\n").replace(/^\s*\n/, "").trimEnd();

export function notesRoutes({ db, scheduler, assets }) {
  const timeZone = () => db.settings.get().timezone;
  const peopleByName = () => db.people.all();

  function noteFrom(match) {
    const note = db.notes.get(Number(match[1]));
    if (!note) throw new HttpError(404, "That note is not in the notebook — it may have been deleted.");
    return note;
  }

  /* What a note's form says, checked. A person deleted meanwhile is let go
   * of, quietly: the note is what matters. */
  function readNote(form) {
    const values = {
      title: form.get("title").replace(/\s+/g, " "),
      body: readText(form, "body"),
      personId: Number(form.get("person")) || null,
      pinned: form.has("pinned"),
    };
    if (values.personId && !db.people.get(values.personId)) values.personId = null;
    const errors = {};
    if (values.title.length > MAX_TITLE) errors.title = `Keep the title to ${MAX_TITLE} characters.`;
    if ([...values.body].length > MAX_BODY) errors.body = `Keep a note under ${MAX_BODY.toLocaleString("en")} characters — split it in two.`;
    if (!values.title && !values.body.trim()) errors.body = "Write something first.";
    return { values, errors };
  }

  function notesList(ctx) {
    const params = ctx.url.searchParams;
    const query = (params.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const typedTag = normalizeTag((params.get("tag") ?? "").trim().replace(/^#/, ""));
    const tag = IS_TAG.test(typedTag) ? typedTag : null;
    const notes = query ? [] : db.notes.list({ tag, limit: LIST_LIMIT + 1 });
    ctx.page(
      200,
      notesPage({
        notes: notes.slice(0, LIST_LIMIT),
        more: notes.length > LIST_LIMIT,
        results: query ? db.notes.search(searchQuery(query)) : [],
        query,
        tag: query ? null : tag,
        tags: db.notes.tags(),
        counts: { notes: db.notes.count(), journal: db.journal.count() },
        timeZone: timeZone(),
        assets,
        flash: ctx.flash,
      }),
    );
  }

  const renderForm = (ctx, { status = 200, note = null, values, errors = {} }) =>
    ctx.page(status, noteFormPage({ note, values, errors, people: peopleByName(), assets, flash: ctx.flash }));

  function noteNew(ctx) {
    const about = Number(ctx.url.searchParams.get("person")) || null;
    renderForm(ctx, { values: { title: "", body: "", personId: about && db.people.get(about) ? about : null, pinned: false } });
  }

  async function noteCreate(ctx) {
    const { values, errors } = readNote(await readForm(ctx.req, MAX_FORM));
    if (Object.keys(errors).length) return renderForm(ctx, { status: 422, values, errors });
    const id = db.notes.create(values);
    ctx.back(`/notes/${id}`, "ok", "Note saved.");
  }

  function noteShow(ctx, match) {
    ctx.page(200, notePage({ note: noteFrom(match), timeZone: timeZone(), assets, flash: ctx.flash }));
  }

  function noteEdit(ctx, match) {
    const note = noteFrom(match);
    renderForm(ctx, { note, values: { title: note.title, body: note.body, personId: note.person?.id ?? null, pinned: note.pinned } });
  }

  async function noteUpdate(ctx, match) {
    const note = noteFrom(match);
    const { values, errors } = readNote(await readForm(ctx.req, MAX_FORM));
    if (Object.keys(errors).length) return renderForm(ctx, { status: 422, note, values, errors });
    db.notes.update(note.id, values);
    ctx.back(`/notes/${note.id}`, "ok", "Saved.");
  }

  async function notePin(ctx, match) {
    const form = await readForm(ctx.req);
    const note = noteFrom(match);
    const pinned = form.get("pinned") === "1";
    db.notes.setPinned(note.id, pinned);
    ctx.back(`/notes/${note.id}`, "ok", pinned ? "Pinned to the top of Notes." : "Unpinned.");
  }

  async function noteDelete(ctx, match) {
    await readForm(ctx.req);
    const note = db.notes.get(Number(match[1]));
    if (note) db.notes.remove(note.id);
    ctx.back("/notes", "ok", note ? "Note deleted." : "Already deleted.");
  }

  const journalToday = (ctx) => redirect(ctx.res, `/journal/${isoDate(scheduler.today().date)}`);

  function journalShow(ctx, match) {
    const date = readDay(match[1]);
    if (!date) throw new HttpError(404, "There is no such day.");
    ctx.page(
      200,
      journalPage({
        date,
        today: scheduler.today().date,
        page: db.journal.get(match[1]),
        recent: db.journal.recent(14),
        people: db.people.active().filter((p) => isBirthdayOn(p, date)),
        timeZone: timeZone(),
        assets,
        flash: ctx.flash,
      }),
    );
  }

  /* The day's page, saved from the journal or from Today (back=today). */
  async function journalSave(ctx, match) {
    const date = readDay(match[1]);
    if (!date) throw new HttpError(404, "There is no such day.");
    const form = await readForm(ctx.req, MAX_FORM);
    const body = readText(form, "body");
    const to = form.get("back") === "today" ? "/" : `/journal/${match[1]}`;
    if ([...body].length > MAX_BODY) return ctx.back(to, "error", `A page holds up to ${MAX_BODY.toLocaleString("en")} characters, so this one was not saved.`);
    const had = Boolean(db.journal.get(match[1]));
    db.journal.save(match[1], body);
    const when = match[1] === isoDate(scheduler.today().date) ? "today’s page" : `the page for ${formatShortDate(date)}`;
    if (body.trim()) ctx.back(to, "ok", `Saved ${when}.`);
    else ctx.back(to, "info", had ? `Cleared ${when}.` : "Nothing to save — the page is empty.");
  }

  return [
    ["GET", /^\/notes$/, notesList],
    ["GET", /^\/notes\/new$/, noteNew],
    ["POST", /^\/notes$/, noteCreate],
    ["GET", /^\/notes\/(\d+)$/, noteShow],
    ["GET", /^\/notes\/(\d+)\/edit$/, noteEdit],
    ["POST", /^\/notes\/(\d+)$/, noteUpdate],
    ["POST", /^\/notes\/(\d+)\/pin$/, notePin],
    ["POST", /^\/notes\/(\d+)\/delete$/, noteDelete],
    ["GET", /^\/journal$/, journalToday],
    ["GET", /^\/journal\/(\d{4}-\d{2}-\d{2})$/, journalShow],
    ["POST", /^\/journal\/(\d{4}-\d{2}-\d{2})$/, journalSave],
  ];
}
