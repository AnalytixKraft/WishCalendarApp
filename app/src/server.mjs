/* The web app: node:http, server-rendered pages, plain form posts. Every page
 * but sign-in needs the session cookie; every post must come from one of
 * these pages (isSameOrigin). */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSVG } from "uqr";
import { COOKIE, MAX_AGE_S, MAX_PASSWORD, MIN_PASSWORD, createAuth, createThrottle } from "./auth.mjs";
import { parsePeople } from "./csv.mjs";
import {
  MONTHS,
  ageOn,
  daysInMonth,
  isBirthdayOn,
  isValidDayMonth,
  isValidTimeZone,
  nextBirthday,
  ordinal,
  parseTime,
  upcomingBirthdays,
} from "./dates.mjs";
import {
  HttpError,
  clientAddress,
  describeError,
  isHttps,
  isSameOrigin,
  parseCookies,
  readForm,
  redirect,
  send,
  sendHtml,
  sendJson,
  serializeCookie,
} from "./http.mjs";
import { DEFAULT_ANNIVERSARY_TEMPLATE, DEFAULT_TEMPLATE, MAX_TEMPLATE, defaultTemplateFor, renderWish } from "./messages.mjs";
import { formatPhone, normalizePhone } from "./phone.mjs";
import { NotSendable, destinationOf } from "./scheduler.mjs";
import * as views from "./views.mjs";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const GROUP_JID = /^\d+(-\d+)?@g\.us$/;
const FLASH = "bdr_flash";
const STATIC_TYPES = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml" };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* The stylesheet, script and icon, read once and addressed by a hash of
 * their content, so a browser can cache them for good and still never run
 * an old copy after an upgrade. */
async function loadAssets() {
  const files = new Map();
  for (const name of ["style.css", "app.js", "favicon.svg"]) {
    const body = await readFile(join(PUBLIC_DIR, name));
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
    files.set(name, { body, hash, type: STATIC_TYPES[name.split(".").pop()] });
  }
  return {
    files,
    css: `/static/style.css?v=${files.get("style.css").hash}`,
    js: `/static/app.js?v=${files.get("app.js").hash}`,
  };
}

/* "Send to": '' (not chosen), 'direct' (the number beside it), a group — or,
 * for the reminder, 'self' (the linked phone). → {sendTo} or {error}. */
function readSendTo(value, phone, { direct = "their", self = false } = {}) {
  if (value === "" || GROUP_JID.test(value) || (self && value === "self")) return { sendTo: value };
  if (value === "direct") {
    return phone ? { sendTo: "direct" } : { error: `Add ${direct} WhatsApp number first — or choose a group.` };
  }
  return { error: "Choose where the wish goes." };
}

const readMessage = (form, name) => form.raw(name).replace(/\r\n/g, "\n").trim().slice(0, MAX_TEMPLATE);

/* A person's own send time: '' (the wish time in Settings) or HH:MM. */
function readTime(value) {
  return value === "" || parseTime(value) !== null ? { time: value } : { error: "Enter a time like 09:30, or leave it empty." };
}

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

function outcomeFlash(result, planned) {
  switch (result.outcome) {
    case "busy":
      return ["info", "Messages are already going out. Check back in a minute."];
    case "idle":
      return ["info", planned ? "Nothing left to send today — everything that can go has gone out." : "Nothing to send today."];
    case "waiting":
      return ["error", `Nothing was sent. ${result.detail}`];
    case "sent":
      return ["ok", `Sent ${plural(result.sent, "message")}.`];
    case "failed":
      return ["error", `${result.sent} sent, ${result.failed} not sent — see Today’s messages.`];
    default:
      return ["info", "Done."];
  }
}

export async function createApp({ config, problems = [], db, bridge, scheduler, log }) {
  const assets = await loadAssets();
  const auth = problems.length ? null : createAuth({ password: config.adminPassword, secret: config.sessionSecret, store: db.password });
  const throttle = createThrottle();

  /* Per request: the cookies, a flash message left by the last redirect, and
   * two ways to answer — render a page (which clears the flash), or go back
   * somewhere with a new one. */
  function context(req, res, url) {
    const cookies = parseCookies(req.headers.cookie);
    let flash = null;
    if (cookies[FLASH]) {
      try {
        const parsed = JSON.parse(Buffer.from(cookies[FLASH], "base64url").toString("utf8"));
        if (["ok", "error", "info"].includes(parsed?.type) && typeof parsed.text === "string") flash = parsed;
      } catch {
        // A mangled flash is no flash.
      }
    }
    const secure = isHttps(req);
    return {
      req,
      res,
      url,
      cookies,
      flash,
      page(status, body) {
        sendHtml(res, status, body, cookies[FLASH] ? { "set-cookie": serializeCookie(FLASH, "", { maxAge: 0, secure }) } : {});
      },
      back(location, type = null, text = null) {
        const payload = text ? Buffer.from(JSON.stringify({ type, text })).toString("base64url") : null;
        redirect(res, location, payload ? { "set-cookie": serializeCookie(FLASH, payload, { maxAge: 60, secure }) } : {});
      },
    };
  }

  async function waStatus() {
    try {
      const status = await bridge.status();
      scheduler.noteStatus(status);
      return { status, error: null };
    } catch (err) {
      return { status: null, error: describeError(err) };
    }
  }

  /* The groups "Send to" can choose from: fresh from WhatsApp when it is
   * connected (and remembered), else the ones it listed last time. */
  async function knownGroups() {
    const { status, error } = await waStatus();
    if (status?.state === "open") {
      try {
        const groups = await bridge.groups();
        db.chats.remember(groups);
        return { groups: groups.map((g) => ({ id: g.id, subject: g.subject || "Unnamed group" })), note: null };
      } catch (err) {
        return { groups: db.chats.all(), note: `${describeError(err)} These are the groups it listed before.` };
      }
    }
    const groups = db.chats.all();
    const why = error || "WhatsApp is not connected";
    return {
      groups,
      note: groups.length
        ? `${why.replace(/\.$/, "")} — the groups below are the ones it listed before.`
        : `${why.replace(/\.$/, "")}, so its groups cannot be listed yet. Link it in Settings.`,
    };
  }

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

  function timeZones(current) {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.includes(current) ? zones : [current, ...zones];
  }

  function personFrom(match) {
    const person = db.people.get(Number(match[1]));
    if (!person) throw new HttpError(404, "That person is not on the list — they may have been removed.");
    return person;
  }

  /* ------------------------------------------------------------ handlers */

  async function login(ctx) {
    const { req, res } = ctx;
    const address = clientAddress(req);
    const today = scheduler.today().date;
    const wait = throttle.waitMinutes(address);
    if (wait) {
      return ctx.page(429, views.signInPage({ today, error: `Too many wrong passwords. Try again in ${plural(wait, "minute")}.`, assets }));
    }
    const form = await readForm(req, 10_000);
    if (!auth.checkPassword(form.raw("password"))) {
      throttle.fail(address);
      log.warn({ address }, "wrong password");
      return ctx.page(401, views.signInPage({ today, error: "That is not the password.", assets }));
    }
    throttle.reset(address);
    log.info({ address }, "signed in");
    redirect(res, "/", { "set-cookie": serializeCookie(COOKIE, auth.issue(), { maxAge: MAX_AGE_S, secure: isHttps(req) }) });
  }

  async function today(ctx) {
    const { settings, date } = scheduler.today();
    const people = db.people.active();
    ctx.page(
      200,
      views.todayPage({
        today: date,
        settings,
        wa: await waStatus(), // first: it tells the scheduler who is linked
        reminderLabel: destinationOf(settings.reminderTo, settings.myPhone, db.chats.names())?.label ?? null,
        alertLabel: destinationOf(settings.alertTo, settings.myPhone, db.chats.names())?.label ?? null,
        agenda: scheduler.agenda(),
        upcoming: upcomingBirthdays(people, date, 30),
        recent: db.deliveries.recent(15),
        last: scheduler.last,
        counts: { people: db.people.count(), unassigned: people.filter((p) => !p.sendTo).length },
        assets,
        flash: ctx.flash,
      }),
    );
  }

  async function runNow(ctx) {
    await readForm(ctx.req);
    const planned = scheduler.agenda().length;
    ctx.back("/", ...outcomeFlash(await scheduler.run({ force: true }), planned));
  }

  async function retry(ctx) {
    const form = await readForm(ctx.req);
    ctx.back("/", ...outcomeFlash(await scheduler.run({ force: true, only: form.get("key") }), 1));
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
      views.peoplePage({
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
      views.personFormPage({
        person,
        values,
        groups,
        errors,
        preview: previewFor(values, settings, groups),
        birthdayToday: person ? isBirthdayOn(person, scheduler.today().date) : false,
        wishTime: settings.wishTime,
        previewTo: settings.myPhone ? formatPhone(settings.myPhone) : "the linked phone",
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
    ctx.page(200, views.importPage({ countryCode: db.settings.get().countryCode, assets, flash: ctx.flash }));
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
      views.importPage({
        result: { added, duplicates, errors, warnings },
        // Kept when some lines failed: fix them and add again — the lines
        // that went in are skipped as already on the list.
        text: errors.length ? text : "",
        countryCode,
        assets,
      }),
    );
  }

  /* WhatsApp is a section of Settings now; old links still arrive. */
  const whatsapp = (ctx) => redirect(ctx.res, "/settings#whatsapp");

  /* For the WhatsApp section's polling (Settings). Never the QR itself — that is only ever
   * the image below. */
  async function whatsappStatusJson(ctx) {
    const { status, error } = await waStatus();
    sendJson(
      ctx.res,
      200,
      status
        ? { state: status.state, has_qr: Boolean(status.qr), qr_expires_at: status.qr_expires_at, since: status.since }
        : { state: "unreachable", error },
    );
  }

  async function whatsappQr(ctx) {
    const { status } = await waStatus();
    if (!status?.qr) return send(ctx.res, 404, "No QR code right now.", { "content-type": "text/plain; charset=utf-8" });
    send(ctx.res, 200, renderSVG(status.qr, { border: 2 }), { "content-type": "image/svg+xml" });
  }

  async function whatsappPair(ctx) {
    await readForm(ctx.req);
    try {
      await bridge.pair();
      ctx.back("/settings#whatsapp");
    } catch (err) {
      ctx.back("/settings#whatsapp", "error", describeError(err));
    }
  }

  async function whatsappLogout(ctx) {
    await readForm(ctx.req);
    try {
      const status = await bridge.logout();
      ctx.back("/settings#whatsapp", status.last_error ? "info" : "ok", status.last_error || "Unlinked. Nothing is sent until a phone is linked again.");
    } catch (err) {
      ctx.back("/settings#whatsapp", "error", describeError(err));
    }
  }

  async function renderSettings(ctx, { status = 200, values, errors = {} }) {
    const wa = await waStatus();
    const { groups } = await knownGroups();
    ctx.page(status, views.settingsPage({ values, errors, timeZones: timeZones(values.timezone), groups, wa, assets, flash: ctx.flash }));
  }

  /* Settings → Password. The current one first, counted like a sign-in, so
   * a borrowed session cannot be turned into a guessing machine. Answers go
   * back as a flash message, never with what was typed. */
  async function passwordSave(ctx) {
    const { req, res } = ctx;
    const form = await readForm(req, 10_000);
    const address = clientAddress(req);
    const wait = throttle.waitMinutes(address);
    if (wait) return ctx.back("/settings", "error", `Too many wrong passwords. Try again in ${plural(wait, "minute")}.`);
    const next = form.raw("next");
    if (!auth.checkPassword(form.raw("current"))) {
      throttle.fail(address);
      log.warn({ address }, "password not changed: wrong current password");
      return ctx.back("/settings", "error", "The current password is not right, so the password was not changed.");
    }
    if (next.length < MIN_PASSWORD || next.length > MAX_PASSWORD) {
      return ctx.back("/settings", "error", `The new password needs ${MIN_PASSWORD} to ${MAX_PASSWORD} characters. Nothing was changed.`);
    }
    if (next !== form.raw("again")) return ctx.back("/settings", "error", "The two new passwords are not the same. Nothing was changed.");
    auth.setPassword(next);
    throttle.reset(address);
    log.info({ address }, "password changed");
    // This browser stays signed in (a cookie under the new key); every other
    // one is signed out by the change itself.
    const secure = isHttps(req);
    const flash = Buffer.from(JSON.stringify({ type: "ok", text: "Password changed. Every other browser is signed out." })).toString("base64url");
    redirect(res, "/settings", {
      "set-cookie": [
        serializeCookie(COOKIE, auth.issue(), { maxAge: MAX_AGE_S, secure }),
        serializeCookie(FLASH, flash, { maxAge: 60, secure }),
      ],
    });
  }

  /* Settings → Alerts → Send a test alert: to where alerts go, as saved. */
  async function testAlert(ctx) {
    await readForm(ctx.req);
    try {
      const to = await scheduler.sendTestAlert();
      ctx.back("/settings", "ok", `Test alert sent to ${to.label}.`);
    } catch (err) {
      ctx.back("/settings", "error", `The test alert was not sent: ${err instanceof NotSendable ? err.message : describeError(err)}`);
    }
  }

  function settingsForm(ctx) {
    const values = db.settings.get();
    return renderSettings(ctx, { values: { ...values, myPhone: formatPhone(values.myPhone) } });
  }

  async function settingsSave(ctx) {
    const form = await readForm(ctx.req);
    const before = db.settings.get();
    const values = {
      enabled: form.has("enabled"),
      wishTime: form.get("wishTime"),
      reminderTime: form.get("reminderTime"),
      timezone: isValidTimeZone(form.get("timezone")) ? form.get("timezone") : before.timezone,
      daysAhead: form.get("daysAhead"),
      template: readMessage(form, "template"),
      anniversaryTemplate: readMessage(form, "anniversaryTemplate"),
      myPhone: form.get("myPhone"),
      reminderTo: form.get("reminderTo"),
      // A Settings page opened before alerts existed has no such field: saving
      // it keeps them as they are, rather than turning them off.
      alertTo: form.has("alertTo") ? form.get("alertTo") : before.alertTo,
      countryCode: form.get("countryCode").replace(/^\+/, ""),
    };
    const errors = {};
    if (parseTime(values.wishTime) === null) errors.wishTime = "Enter a time like 08:00.";
    if (parseTime(values.reminderTime) === null) errors.reminderTime = "Enter a time like 07:00.";
    const daysAhead = Number(values.daysAhead);
    if (values.daysAhead === "" || !Number.isInteger(daysAhead) || daysAhead < 0 || daysAhead > 30) {
      errors.daysAhead = "Enter a whole number from 0 to 30.";
    }
    if (!/^[1-9]\d{0,3}$/.test(values.countryCode)) errors.countryCode = "Enter a country code, like 91.";
    const myPhone = normalizePhone(values.myPhone, errors.countryCode ? before.countryCode : values.countryCode);
    if (myPhone.error) errors.myPhone = myPhone.error;
    const reminderTo = readSendTo(values.reminderTo, myPhone.phone, { direct: "your", self: true });
    if (reminderTo.error && !myPhone.error) errors.reminderTo = reminderTo.error;
    const alertTo = readSendTo(values.alertTo, myPhone.phone, { direct: "your", self: true });
    if (alertTo.error && !myPhone.error) errors.alertTo = alertTo.error;
    if (Object.keys(errors).length) return renderSettings(ctx, { status: 422, values, errors });

    db.settings.save({
      ...values,
      daysAhead,
      template: values.template || DEFAULT_TEMPLATE,
      anniversaryTemplate: values.anniversaryTemplate || DEFAULT_ANNIVERSARY_TEMPLATE,
      myPhone: myPhone.phone,
      reminderTo: reminderTo.sendTo,
      alertTo: alertTo.sendTo,
    });
    let text = "Settings saved.";
    if (values.enabled && !before.enabled) {
      scheduler.sendingTurnedOn();
      const due = scheduler.agenda().filter((job) => job.to && job.due && job.delivery?.status !== "sent");
      text = due.length ? `Sending is on. ${plural(due.length, "message")} due today will go out within a minute.` : "Sending is on.";
    } else if (!values.enabled && before.enabled) {
      text = "Sending is paused. Nothing goes out on its own until you turn it back on.";
    }
    ctx.back("/settings", "ok", text);
  }

  const routes = [
    ["GET", /^\/$/, today],
    ["POST", /^\/run$/, runNow],
    ["POST", /^\/retry$/, retry],
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
    ["GET", /^\/whatsapp$/, whatsapp],
    ["GET", /^\/whatsapp\/status\.json$/, whatsappStatusJson],
    ["GET", /^\/whatsapp\/qr\.svg$/, whatsappQr],
    ["POST", /^\/whatsapp\/pair$/, whatsappPair],
    ["POST", /^\/whatsapp\/logout$/, whatsappLogout],
    ["GET", /^\/settings$/, settingsForm],
    ["POST", /^\/settings\/messages$/, defaultMessagesSave],
    ["POST", /^\/settings\/password$/, passwordSave],
    ["POST", /^\/settings\/test-alert$/, testAlert],
    ["POST", /^\/settings$/, settingsSave],
  ];

  function serveStatic(res, name, url) {
    const file = assets.files.get(name);
    if (!file) return send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
    const cache = url.searchParams.get("v") === file.hash ? "public, max-age=31536000, immutable" : "no-cache";
    send(res, 200, file.body, { "content-type": file.type, "cache-control": cache });
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url || "/", "http://app");
    } catch {
      return send(res, 400, "Bad request", { "content-type": "text/plain; charset=utf-8" });
    }
    const path = url.pathname;
    if (path === "/healthz") return sendJson(res, 200, { ok: true });
    if (path.startsWith("/static/")) return serveStatic(res, path.slice("/static/".length), url);
    if (problems.length) return sendHtml(res, 503, views.notConfiguredPage({ problems, assets }));

    const ctx = context(req, res, url);
    if (req.method === "POST" && !isSameOrigin(req)) {
      return ctx.page(403, views.errorPage({ status: 403, message: "That form was sent from another site, so it was not accepted.", assets, signedIn: false }));
    }
    const signedIn = auth.verify(ctx.cookies[COOKIE]);
    if (path === "/login") {
      if (req.method === "POST") return login(ctx);
      if (signedIn) return redirect(res, "/");
      return ctx.page(200, views.signInPage({ today: scheduler.today().date, assets }));
    }
    if (path === "/logout" && req.method === "POST") {
      return redirect(res, "/login", { "set-cookie": serializeCookie(COOKIE, "", { maxAge: 0, secure: isHttps(req) }) });
    }
    if (!signedIn) {
      if (req.method === "GET" && !/\.(json|svg)$/.test(path)) return redirect(res, "/login");
      return send(res, 401, "Sign in first.", { "content-type": "text/plain; charset=utf-8" });
    }
    const method = req.method === "HEAD" ? "GET" : req.method;
    for (const [routeMethod, pattern, handler] of routes) {
      const match = pattern.exec(path);
      if (match && routeMethod === method) return handler(ctx, match);
    }
    ctx.page(404, views.errorPage({ status: 404, message: "There is no page at this address.", assets }));
  }

  return createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        return sendHtml(res, err.status, views.errorPage({ status: err.status, message: err.message, assets }));
      }
      log.error({ err: err?.stack || String(err), method: req.method, path: req.url }, "request failed");
      sendHtml(
        res,
        500,
        views.errorPage({ status: 500, message: "The app hit an unexpected error. Its log says more: docker compose logs app.", assets }),
      );
    }
  });
}
