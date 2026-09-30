/* The web app: node:http, server-rendered pages, plain form posts. Every page
 * but sign-in needs the session cookie; every post must come from one of
 * these pages (isSameOrigin). */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSVG } from "uqr";
import { COOKIE, MAX_AGE_S, createAuth, createThrottle } from "./auth.mjs";
import { parsePeople } from "./csv.mjs";
import {
  ageOn,
  daysInMonth,
  formatDayMonth,
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
import { DEFAULT_TEMPLATE, MAX_TEMPLATE, renderWish } from "./messages.mjs";
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

/* What a person's form says, checked. */
function readPerson(form) {
  const values = {
    name: form.get("name").replace(/\s+/g, " "),
    day: form.get("day"),
    month: form.get("month"),
    year: form.get("year"),
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
  return {
    values,
    errors,
    data: { name: values.name, day, month, year, notes: values.notes, active: values.active, chatIds: form.all("chats") },
  };
}

function outcomeFlash(result, planned) {
  switch (result.outcome) {
    case "busy":
      return ["info", "Messages are already going out. Check back in a minute."];
    case "idle":
      return ["info", planned ? "Nothing left to send today — everything has gone out." : "Nothing to send today."];
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
  const auth = problems.length ? null : createAuth({ password: config.adminPassword, secret: config.sessionSecret });
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
      return { status: await bridge.status(), error: null };
    } catch (err) {
      return { status: null, error: describeError(err) };
    }
  }

  function findChat(form) {
    const chat = db.chats.get(form.get("id"));
    if (!chat) throw new HttpError(404, "That group is no longer on the Groups page.");
    return chat;
  }

  /* Someone to show the wish preview for: whoever is next, or an example. */
  function sampleFor(date, settings) {
    const next = upcomingBirthdays(db.people.active(), date, 366)[0];
    const person = next?.person ?? { id: 0, name: "Anu Joseph", day: date.day, month: date.month, year: date.year - 30 };
    const on = next?.date ?? date;
    const age = ageOn(person, on);
    return {
      label: next ? `${person.name}, ${formatDayMonth(on)}` : "an example",
      data: {
        name: person.name,
        first_name: person.name.trim().split(/\s+/)[0],
        age: age ? String(age) : "",
        ordinal_age: age ? ordinal(age) : "",
      },
      render: (chat) => renderWish(chat.template || settings.template, { person, date: on, groupName: chat.subject }),
    };
  }

  function timeZones(current) {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.includes(current) ? zones : [current, ...zones];
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
    ctx.page(
      200,
      views.todayPage({
        today: date,
        settings,
        wa: await waStatus(),
        agenda: scheduler.agenda(),
        upcoming: upcomingBirthdays(db.people.active(), date, 30),
        recent: db.deliveries.recent(15),
        last: scheduler.last,
        counts: { people: db.people.count(), chats: db.chats.all().length },
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

  function peopleList(ctx) {
    const { date } = scheduler.today();
    const assignments = db.people.assignments();
    const rows = db.people
      .all()
      .map((person) => ({ person, ...nextBirthday(person, date), chatIds: [...(assignments.get(person.id) || [])] }))
      .sort(
        (a, b) =>
          Number(b.person.active) - Number(a.person.active) ||
          a.inDays - b.inDays ||
          a.person.name.localeCompare(b.person.name),
      );
    const chatNames = new Map(db.chats.all().map((c) => [c.id, c.subject]));
    ctx.page(200, views.peoplePage({ rows, chatNames, assets, flash: ctx.flash }));
  }

  function personNew(ctx) {
    const chats = db.chats.all();
    ctx.page(
      200,
      views.personFormPage({
        person: null,
        values: { name: "", day: "", month: "", year: "", notes: "", active: true },
        chats,
        selected: new Set(chats.filter((c) => c.wishes).map((c) => c.id)),
        assets,
        flash: ctx.flash,
      }),
    );
  }

  async function personCreate(ctx) {
    const { values, errors, data } = readPerson(await readForm(ctx.req));
    if (!errors.name && !errors.birthday && db.people.exists(data.name, data.day, data.month)) {
      errors.name = `${data.name} is already on the list with this birthday.`;
    }
    if (Object.keys(errors).length) {
      return ctx.page(
        422,
        views.personFormPage({ person: null, values, chats: db.chats.all(), selected: new Set(data.chatIds), errors, assets }),
      );
    }
    db.people.create(data);
    ctx.back("/people", "ok", `Added ${data.name}.`);
  }

  function personFrom(match) {
    const person = db.people.get(Number(match[1]));
    if (!person) throw new HttpError(404, "That person is not on the list — they may have been removed.");
    return person;
  }

  function personEdit(ctx, match) {
    const person = personFrom(match);
    ctx.page(
      200,
      views.personFormPage({
        person,
        values: { ...person, year: person.year ?? "" },
        chats: db.chats.all(),
        selected: new Set(db.people.chatIds(person.id)),
        assets,
        flash: ctx.flash,
      }),
    );
  }

  async function personUpdate(ctx, match) {
    const person = personFrom(match);
    const { values, errors, data } = readPerson(await readForm(ctx.req));
    if (Object.keys(errors).length) {
      return ctx.page(
        422,
        views.personFormPage({ person, values, chats: db.chats.all(), selected: new Set(data.chatIds), errors, assets }),
      );
    }
    db.people.update(person.id, data);
    ctx.back("/people", "ok", `Saved ${data.name}.`);
  }

  async function personDelete(ctx, match) {
    await readForm(ctx.req);
    const person = db.people.get(Number(match[1]));
    if (person) db.people.remove(person.id);
    ctx.back("/people", "ok", person ? `Removed ${person.name} from the list.` : "Already removed.");
  }

  function importForm(ctx) {
    ctx.page(200, views.importPage({ chats: db.chats.all(), assets, flash: ctx.flash }));
  }

  async function importList(ctx) {
    const form = await readForm(ctx.req, 2_000_000);
    const text = form.raw("list");
    const { people, errors } = parsePeople(text);
    const chats = db.chats.all();
    const byName = new Map(chats.map((c) => [c.subject.trim().toLowerCase(), c]));
    const everyWishGroup = chats.filter((c) => c.wishes).map((c) => c.id);
    const warnings = [];
    let added = 0;
    let duplicates = 0;
    db.transaction(() => {
      for (const p of people) {
        if (db.people.exists(p.name, p.day, p.month)) {
          duplicates++;
          continue;
        }
        let chatIds = everyWishGroup;
        if (p.groupNames) {
          chatIds = [];
          for (const name of p.groupNames) {
            const chat = byName.get(name.toLowerCase());
            if (chat) chatIds.push(chat.id);
            else warnings.push(`Line ${p.line}: there is no group called “${name}” — ${p.name} was added without it.`);
          }
        }
        db.people.create({ name: p.name, day: p.day, month: p.month, year: p.year, notes: p.notes, active: true, chatIds });
        added++;
      }
    });
    log.info({ added, duplicates, errors: errors.length }, "imported people");
    ctx.page(
      errors.length ? 422 : 200,
      views.importPage({
        result: { added, duplicates, errors, warnings },
        // Kept when some lines failed: fix them and import again — the lines
        // that went in are skipped as already on the list.
        text: errors.length ? text : "",
        chats,
        assets,
      }),
    );
  }

  async function groupsList(ctx) {
    const wa = await waStatus();
    let available = null;
    if (wa.status?.state === "open") {
      try {
        const groups = await bridge.groups();
        for (const g of groups) if (g.subject) db.chats.rename(g.id, g.subject);
        const added = new Set(db.chats.all().map((c) => c.id));
        available = groups.filter((g) => !added.has(g.id));
      } catch (err) {
        wa.error = describeError(err);
      }
    } else if (wa.status) {
      wa.error = "WhatsApp is not connected.";
    }
    const settings = db.settings.get();
    ctx.page(
      200,
      views.groupsPage({
        chats: db.chats.all(),
        counts: db.chats.memberCounts(),
        available,
        wa,
        sample: sampleFor(scheduler.today().date, settings),
        defaultTemplate: settings.template,
        assets,
        flash: ctx.flash,
      }),
    );
  }

  async function groupAdd(ctx) {
    const form = await readForm(ctx.req);
    const id = form.get("id");
    if (!GROUP_JID.test(id)) throw new HttpError(400, "That is not a WhatsApp group.");
    const subject = form.get("subject").slice(0, 200) || "Unnamed group";
    const forReminder = form.get("purpose") === "reminders";
    db.chats.add({ id, subject, wishes: !forReminder, reminders: forReminder });
    ctx.back(
      "/groups",
      "ok",
      forReminder
        ? `Your daily reminder will be posted in ${subject}.`
        : db.people.count()
          ? `Added ${subject}. Choose who is wished there — “Wish everyone on the list here” adds everyone at once.`
          : `Added ${subject}.`,
    );
  }

  async function groupUpdate(ctx) {
    const form = await readForm(ctx.req);
    const chat = findChat(form);
    let template = form.raw("template").replace(/\r\n/g, "\n").trim().slice(0, MAX_TEMPLATE);
    if (template === db.settings.get().template.trim()) template = "";
    db.chats.update(chat.id, { wishes: form.has("wishes"), reminders: form.has("reminders"), template });
    ctx.back("/groups", "ok", `Saved ${chat.subject}.`);
  }

  async function groupEveryone(ctx) {
    const chat = findChat(await readForm(ctx.req));
    const n = db.chats.addEveryone(chat.id);
    ctx.back(
      "/groups",
      "ok",
      n ? `${plural(n, "person", "people")} added — everyone on the list is wished in ${chat.subject}.` : `Everyone on the list was already wished in ${chat.subject}.`,
    );
  }

  async function groupTest(ctx) {
    const chat = findChat(await readForm(ctx.req));
    try {
      await scheduler.sendTest(chat);
      ctx.back("/groups", "ok", `Posted a test message in ${chat.subject}.`);
    } catch (err) {
      ctx.back("/groups", "error", describeError(err));
    }
  }

  async function groupRemove(ctx) {
    const chat = findChat(await readForm(ctx.req));
    db.chats.remove(chat.id);
    ctx.back("/groups", "ok", `Stopped posting in ${chat.subject}.`);
  }

  async function whatsapp(ctx) {
    const wa = await waStatus();
    ctx.page(200, views.whatsappPage({ status: wa.status, error: wa.error, assets, flash: ctx.flash }));
  }

  /* For the WhatsApp page's polling. Never the QR itself — that is only ever
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
      ctx.back("/whatsapp");
    } catch (err) {
      ctx.back("/whatsapp", "error", describeError(err));
    }
  }

  async function whatsappLogout(ctx) {
    await readForm(ctx.req);
    try {
      const status = await bridge.logout();
      ctx.back("/whatsapp", status.last_error ? "info" : "ok", status.last_error || "Unlinked. Nothing is sent until a phone is linked again.");
    } catch (err) {
      ctx.back("/whatsapp", "error", describeError(err));
    }
  }

  function settingsForm(ctx) {
    const values = db.settings.get();
    ctx.page(200, views.settingsPage({ values, timeZones: timeZones(values.timezone), assets, flash: ctx.flash }));
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
      template: form.raw("template").replace(/\r\n/g, "\n").trim(),
    };
    const errors = {};
    if (parseTime(values.wishTime) === null) errors.wishTime = "Enter a time like 08:00.";
    if (parseTime(values.reminderTime) === null) errors.reminderTime = "Enter a time like 07:00.";
    const daysAhead = Number(values.daysAhead);
    if (values.daysAhead === "" || !Number.isInteger(daysAhead) || daysAhead < 0 || daysAhead > 30) {
      errors.daysAhead = "Enter a whole number from 0 to 30.";
    }
    if (values.template.length > MAX_TEMPLATE) errors.template = `Keep the message to ${MAX_TEMPLATE} characters.`;
    if (Object.keys(errors).length) {
      return ctx.page(422, views.settingsPage({ values, errors, timeZones: timeZones(values.timezone), assets }));
    }
    db.settings.save({ ...values, daysAhead, template: values.template || DEFAULT_TEMPLATE });
    let text = "Settings saved.";
    if (values.enabled && !before.enabled) {
      const due = scheduler.agenda().filter((job) => job.due && job.delivery?.status !== "sent");
      text = due.length
        ? `Sending is on. ${plural(due.length, "message")} due today will go out within a minute.`
        : "Sending is on.";
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
    ["GET", /^\/people\/new$/, personNew],
    ["POST", /^\/people$/, personCreate],
    ["GET", /^\/people\/import$/, importForm],
    ["POST", /^\/people\/import$/, importList],
    ["GET", /^\/people\/(\d+)$/, personEdit],
    ["POST", /^\/people\/(\d+)$/, personUpdate],
    ["POST", /^\/people\/(\d+)\/delete$/, personDelete],
    ["GET", /^\/groups$/, groupsList],
    ["POST", /^\/groups\/add$/, groupAdd],
    ["POST", /^\/groups\/update$/, groupUpdate],
    ["POST", /^\/groups\/everyone$/, groupEveryone],
    ["POST", /^\/groups\/test$/, groupTest],
    ["POST", /^\/groups\/remove$/, groupRemove],
    ["GET", /^\/whatsapp$/, whatsapp],
    ["GET", /^\/whatsapp\/status\.json$/, whatsappStatusJson],
    ["GET", /^\/whatsapp\/qr\.svg$/, whatsappQr],
    ["POST", /^\/whatsapp\/pair$/, whatsappPair],
    ["POST", /^\/whatsapp\/logout$/, whatsappLogout],
    ["GET", /^\/settings$/, settingsForm],
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
