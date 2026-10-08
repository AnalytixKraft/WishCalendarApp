/* People: the table, a person's own page, uploading a list, and the default
 * messages panel. */

import { parsePeople } from "../csv.mjs";
import { MONTHS, ageOn, daysInMonth, isBirthdayOn, isValidDayMonth, nextBirthday, ordinal } from "../dates.mjs";
import { HttpError, describeError, readForm } from "../http.mjs";
import { DEFAULT_ANNIVERSARY_TEMPLATE, DEFAULT_TEMPLATE, defaultTemplateFor, renderWish } from "../messages.mjs";
import { formatPhone, normalizePhone } from "../phone.mjs";
import { NotSendable } from "../scheduler.mjs";
import { plural } from "../views/html.mjs";
import { importPage, peoplePage, personFormPage } from "../views/people.mjs";
import { GROUP_JID, readMessage, readSendTo, readTime } from "./forms.mjs";

/* What a person's form says, checked. */
function readPerson(form, countryCode) {
  const values = {
    kind: form.get("kind") === "anniversary" ? "anniversary" : "birthday",
    name: form.get("name").replace(/\s+/g, " "),
    day: form.get("day"),
    month: form.get("month"),
    year: form.get("year"),
    phone: form.get("phone"),
    sendTo: form.get("sendTo"),
    sendTime: form.get("sendTime"),
    message: readMessage(form, "message"),
    notes: form.get("notes").slice(0, 500),
    active: form.has("active"),
  };
  const errors = {};
  const thisYear = new Date().getUTCFullYear();
  if (!values.name) errors.name = "Enter their name.";
  else if (values.name.length > 100) errors.name = "Keep the name to 100 characters.";
  const day = Number(values.day);
  const month = Number(values.month);
  if (!isValidDayMonth(day, month)) errors.birthday = "Pick the day and the month of their birthday.";
  let year = null;
  if (values.year) {
    year = Number(values.year);
    if (!/^\d{4}$/.test(values.year) || year < 1900 || year > thisYear) {
      errors.year = `Enter a year from 1900 to ${thisYear}, or leave it empty.`;
    } else if (!errors.birthday && day > daysInMonth(year, month)) {
      errors.birthday = `${year} had no 29 February. Check the year, or leave it empty.`;
    }
  }
  const phone = normalizePhone(values.phone, countryCode);
  if (phone.error) errors.phone = phone.error;
  const sendTo = readSendTo(values.sendTo, phone.phone);
  if (sendTo.error && !phone.error) errors.sendTo = sendTo.error;
  const time = readTime(values.sendTime);
  if (time.error) errors.sendTime = time.error;
  return {
    values,
    errors,
    data: {
      kind: values.kind,
      name: values.name,
      day,
      month,
      year,
      notes: values.notes,
      active: values.active,
      phone: phone.phone ?? "",
      sendTo: sendTo.sendTo ?? "",
      sendTime: time.time ?? "",
      message: values.message,
    },
  };
}

/* What "Send now" did, in words. */
function sendNowFlash(person, result) {
  if (!result.sentNow) return ["info", `${person.name}’s wish already went out today — it was not sent again.`];
  if (result.birthday) return ["ok", `Sent ${person.name}’s birthday wish to ${result.to.label}. It won’t go again today.`];
  return ["ok", `Sent ${person.name}’s wish to ${result.to.label}. The one on their birthday still goes out as planned.`];
}

export function peopleRoutes({ db, scheduler, log, assets, knownGroups }) {
  /* What the wish preview needs: this person, on their next birthday. */
  function previewFor(fields, settings, groups) {
    const { date } = scheduler.today();
    const kind = fields.kind === "anniversary" ? "anniversary" : "birthday";
    const who = { kind, name: fields.name || "Their name", day: fields.day || date.day, month: fields.month || date.month, year: fields.year || null };
    const on = isValidDayMonth(Number(who.day), Number(who.month)) ? nextBirthday({ ...who, day: Number(who.day), month: Number(who.month) }, date).date : date;
    const age = ageOn(who, on);
    const group = GROUP_JID.test(fields.sendTo) ? groups.find((g) => g.id === fields.sendTo)?.subject || "" : "";
    return {
      defaultTemplate: defaultTemplateFor(kind, settings),
      defaults: { birthday: settings.template, anniversary: settings.anniversaryTemplate },
      groupName: group,
      sample: { name: who.name, first_name: who.name.trim().split(/\s+/)[0], age: age ? String(age) : "", ordinal_age: age ? ordinal(age) : "" },
      text: renderWish(fields.message || defaultTemplateFor(kind, settings), { person: who, date: on, groupName: group }),
    };
  }

  function personFrom(match) {
    const person = db.people.get(Number(match[1]));
    if (!person) throw new HttpError(404, "That person is not on the list — they may have been removed.");
    return person;
  }

  /* The People table, soonest birthday first (paused people last). `values`
   * and `errors` are a failed save's, shown back as they were typed. */
  async function renderPeople(ctx, { status = 200, values = null, errors, openDefaults = false } = {}) {
    const { settings, date } = scheduler.today();
    const rows = db.people
      .all()
      .map((person) => ({ person, ...nextBirthday(person, date) }))
      .sort(
        (a, b) =>
          Number(b.person.active) - Number(a.person.active) ||
          a.inDays - b.inDays ||
          a.person.name.localeCompare(b.person.name),
      );
    // What each row shows: as typed, for a row of a save that failed (someone
    // added since has none), else as saved.
    const shown = new Map(
      rows.map(({ person: p }) => [
        p.id,
        values?.get(p.id) ?? { phone: formatPhone(p.phone), sendTo: p.sendTo, sendTime: p.sendTime, message: p.message },
      ]),
    );
    const { groups, note } = rows.length ? await knownGroups() : { groups: [], note: null };
    ctx.page(
      status,
      peoplePage({
        rows,
        groups,
        groupsNote: note,
        values: shown,
        errors,
        wishTime: settings.wishTime,
        defaults: { birthday: settings.template, anniversary: settings.anniversaryTemplate, open: openDefaults },
        assets,
        flash: ctx.flash,
      }),
    );
  }

  const peopleList = (ctx) => renderPeople(ctx, { openDefaults: ctx.url.searchParams.has("defaults") });

  /* The Default messages panel on People (the same two as on Settings). */
  async function defaultMessagesSave(ctx) {
    const form = await readForm(ctx.req);
    db.settings.save({
      template: readMessage(form, "template") || DEFAULT_TEMPLATE,
      anniversaryTemplate: readMessage(form, "anniversaryTemplate") || DEFAULT_ANNIVERSARY_TEMPLATE,
    });
    ctx.back("/people?defaults#default-messages", "ok", "Default messages saved.");
  }

  async function peopleSave(ctx) {
    const form = await readForm(ctx.req, 4_000_000);
    const { countryCode } = db.settings.get();
    const values = new Map();
    const errors = new Map();
    const rows = [];
    for (const id of new Set(form.all("id").map(Number).filter(Number.isInteger))) {
      if (!db.people.get(id)) continue; // removed meanwhile
      const typed = {
        phone: form.get(`phone_${id}`),
        sendTo: form.get(`send_to_${id}`),
        sendTime: form.get(`time_${id}`),
        message: readMessage(form, `message_${id}`),
      };
      values.set(id, typed);
      const phone = normalizePhone(typed.phone, countryCode);
      const sendTo = readSendTo(typed.sendTo, phone.phone);
      const time = readTime(typed.sendTime);
      const problems = {};
      if (phone.error) problems.phone = phone.error;
      else if (sendTo.error) problems.sendTo = sendTo.error;
      if (time.error) problems.sendTime = time.error;
      if (Object.keys(problems).length) errors.set(id, problems);
      else rows.push({ id, phone: phone.phone, sendTo: sendTo.sendTo, sendTime: time.time, message: typed.message });
    }
    if (errors.size) {
      return renderPeople(ctx, { status: 422, values, errors }).then(() => undefined);
    }
    db.people.updateMany(rows);

    // A row's "Delete" submits the whole table too: saved first, then that
    // row goes.
    const deleteId = Number(form.get("delete"));
    if (deleteId) {
      const person = db.people.get(deleteId);
      if (person) db.people.remove(person.id);
      return ctx.back(
        "/people",
        "ok",
        person ? `Deleted ${person.name}’s ${person.kind} (${person.day} ${MONTHS[person.month - 1]}).` : "Already deleted.",
      );
    }

    // A row's "Send now" submits the whole table: saved first, then sent.
    const sendId = Number(form.get("send"));
    if (sendId) {
      const person = db.people.get(sendId);
      if (!person) return ctx.back("/people", "error", "That person is no longer on the list.");
      try {
        return ctx.back("/people", ...sendNowFlash(person, await scheduler.sendNow(person)));
      } catch (err) {
        return ctx.back("/people", "error", `Saved, but ${person.name}’s wish was not sent: ${err instanceof NotSendable ? err.message : describeError(err)}`);
      }
    }
    const unassigned = db.people.active().filter((p) => !p.sendTo).length;
    ctx.back("/people", "ok", `Saved.${unassigned ? ` ${plural(unassigned, "person has", "people have")} no “Send to” yet — their wish won’t be sent.` : ""}`);
  }

  async function renderPersonForm(ctx, { status = 200, person = null, values, errors = {} }) {
    const settings = db.settings.get();
    const { groups } = await knownGroups();
    ctx.page(
      status,
      personFormPage({
        person,
        values,
        groups,
        errors,
        preview: previewFor(values, settings, groups),
        birthdayToday: person ? isBirthdayOn(person, scheduler.today().date) : false,
        wishTime: settings.wishTime,
        previewTo: settings.myPhone ? formatPhone(settings.myPhone) : "the linked phone",
        notes: person ? db.notes.forPerson(person.id) : [],
        assets,
        flash: ctx.flash,
      }),
    );
  }

  const personNew = (ctx) =>
    renderPersonForm(ctx, {
      values: {
        kind: ctx.url.searchParams.get("kind") === "anniversary" ? "anniversary" : "birthday",
        name: "",
        day: "",
        month: "",
        year: "",
        phone: "",
        sendTo: "",
        sendTime: "",
        message: "",
        notes: "",
        active: true,
      },
    });

  async function personCreate(ctx) {
    const { values, errors, data } = readPerson(await readForm(ctx.req), db.settings.get().countryCode);
    if (!errors.name && !errors.birthday && db.people.exists(data.name, data.day, data.month, data.kind)) {
      errors.name = `${data.name} is already on the list with this ${data.kind}.`;
    }
    if (Object.keys(errors).length) return renderPersonForm(ctx, { status: 422, values, errors });
    db.people.create(data);
    ctx.back("/people", "ok", `Added ${data.name}’s ${data.kind}.${data.sendTo ? "" : " Choose where the wish goes."}`);
  }

  const personEdit = (ctx, match) => {
    const person = personFrom(match);
    return renderPersonForm(ctx, { person, values: { ...person, year: person.year ?? "", phone: formatPhone(person.phone) } });
  };

  async function personUpdate(ctx, match) {
    const person = personFrom(match);
    const { values, errors, data } = readPerson(await readForm(ctx.req), db.settings.get().countryCode);
    if (Object.keys(errors).length) return renderPersonForm(ctx, { status: 422, person, values, errors });
    db.people.update(person.id, data);
    ctx.back("/people", "ok", `Saved ${data.name}.`);
  }

  async function personPreview(ctx, match) {
    await readForm(ctx.req);
    const person = personFrom(match);
    try {
      await scheduler.sendPreview(person);
      ctx.back(`/people/${person.id}`, "ok", "Preview sent to your number.");
    } catch (err) {
      ctx.back(`/people/${person.id}`, "error", err instanceof NotSendable ? err.message : describeError(err));
    }
  }

  async function personSendNow(ctx, match) {
    await readForm(ctx.req);
    const person = personFrom(match);
    try {
      ctx.back(`/people/${person.id}`, ...sendNowFlash(person, await scheduler.sendNow(person)));
    } catch (err) {
      ctx.back(`/people/${person.id}`, "error", err instanceof NotSendable ? err.message : describeError(err));
    }
  }

  async function personDelete(ctx, match) {
    await readForm(ctx.req);
    const person = db.people.get(Number(match[1]));
    if (person) db.people.remove(person.id);
    ctx.back("/people", "ok", person ? `Deleted ${person.name}’s ${person.kind}.` : "Already deleted.");
  }

  function importForm(ctx) {
    ctx.page(200, importPage({ countryCode: db.settings.get().countryCode, assets, flash: ctx.flash }));
  }

  async function importList(ctx) {
    const form = await readForm(ctx.req, 4_000_000);
    const text = form.raw("list");
    const { countryCode } = db.settings.get();
    const { groups } = await knownGroups();
    const groupsByName = new Map(groups.map((g) => [g.subject.trim().toLowerCase(), g.id]));
    const { people, errors, warnings } = parsePeople(text, { countryCode, groupsByName });
    const added = { birthday: 0, anniversary: 0 };
    let duplicates = 0;
    db.transaction(() => {
      for (const p of people) {
        if (db.people.exists(p.name, p.day, p.month, p.kind)) {
          duplicates++;
          continue;
        }
        db.people.create({ ...p, active: true });
        added[p.kind]++;
      }
    });
    log.info({ ...added, duplicates, errors: errors.length, warnings: warnings.length }, "imported people");
    ctx.page(
      errors.length ? 422 : 200,
      importPage({
        result: { added, duplicates, errors, warnings },
        // Kept when some lines failed: fix them and add again — the lines
        // that went in are skipped as already on the list.
        text: errors.length ? text : "",
        countryCode,
        assets,
      }),
    );
  }

  return [
    ["GET", /^\/people$/, peopleList],
    ["POST", /^\/people\/save$/, peopleSave],
    ["GET", /^\/people\/new$/, personNew],
    ["POST", /^\/people$/, personCreate],
    ["GET", /^\/people\/import$/, importForm],
    ["POST", /^\/people\/import$/, importList],
    ["GET", /^\/people\/(\d+)$/, personEdit],
    ["POST", /^\/people\/(\d+)$/, personUpdate],
    ["POST", /^\/people\/(\d+)\/preview$/, personPreview],
    ["POST", /^\/people\/(\d+)\/send$/, personSendNow],
    ["POST", /^\/people\/(\d+)\/delete$/, personDelete],
    ["POST", /^\/settings\/messages$/, defaultMessagesSave],
  ];
}
