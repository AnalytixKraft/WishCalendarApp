import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addDays, isoDate, zonedNow } from "../src/dates.mjs";
import { openDb } from "../src/db.mjs";
import { silentLog } from "../src/log.mjs";
import { createScheduler } from "../src/scheduler.mjs";
import { createApp } from "../src/server.mjs";

const PASSWORD = "correct horse battery staple";
const fakeBridge = {
  status: async () => ({ state: "idle", me: null, qr: null, last_error: null }),
  groups: async () => [],
  send: async () => {
    throw new Error("not in these tests");
  },
  pair: async () => ({ state: "pairing" }),
  logout: async () => ({ state: "idle" }),
};

let server;
let base;
let db;

before(async () => {
  db = openDb(":memory:");
  const scheduler = createScheduler({ db, bridge: fakeBridge, log: silentLog });
  server = await createApp({
    config: { adminPassword: PASSWORD, sessionSecret: "s".repeat(40) },
    db,
    bridge: fakeBridge,
    scheduler,
    log: silentLog,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function post(path, fields, { cookie, site = "same-origin", address = "10.0.0.1" } = {}) {
  return fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": site,
      "cf-connecting-ip": address,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields),
  });
}

const get = (path, cookie) => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });

async function signIn() {
  const res = await post("/login", { password: PASSWORD });
  assert.equal(res.status, 303);
  const setCookie = res.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  return setCookie.split(";")[0];
}

test("health, and every page behind sign-in", async () => {
  assert.equal((await get("/healthz")).status, 200);
  const res = await get("/");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login");
  assert.equal((await get("/whatsapp/status.json")).status, 401);
});

test("the sign-in page carries the security headers", async () => {
  const res = await get("/login");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(await res.text(), /Sign in/);
});

test("a wrong password is refused; the right one signs in", async () => {
  assert.equal((await post("/login", { password: "nope" }, { address: "10.0.0.2" })).status, 401);
  const cookie = await signIn();
  const res = await get("/", cookie);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Getting started/);
  assert.equal((await get("/", "bdr_session=v1.9999999999.forged.signature")).status, 303);
});

test("five wrong passwords make that address wait", async () => {
  for (let i = 0; i < 5; i++) await post("/login", { password: "wrong" }, { address: "10.0.0.9" });
  const res = await post("/login", { password: PASSWORD }, { address: "10.0.0.9" });
  assert.equal(res.status, 429);
  assert.match(await res.text(), /Too many wrong passwords/);
});

test("a post from another site is refused, signed in or not", async () => {
  const cookie = await signIn();
  const res = await post("/people", { name: "Mallory", day: "1", month: "1", active: "1" }, { cookie, site: "cross-site" });
  assert.equal(res.status, 403);
  assert.equal(db.people.all().some((p) => p.name === "Mallory"), false);
});

test("people are added, and their names are shown as text, never as markup", async () => {
  const cookie = await signIn();
  const res = await post("/people", { name: "<script>alert(1)</script>", day: "30", month: "9", year: "1996", active: "1" }, { cookie });
  assert.equal(res.status, 303);
  const page = await (await get("/people", cookie)).text();
  assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!page.includes("<script>alert(1)</script>"));
});

test("a birthday that does not exist is refused with a reason", async () => {
  const cookie = await signIn();
  const res = await post("/people", { name: "Leap", day: "29", month: "2", year: "1995", active: "1" }, { cookie });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /1995 had no 29 February/);
  const missing = await post("/people", { name: "No date", day: "", month: "", active: "1" }, { cookie });
  assert.equal(missing.status, 422);
});

test("an import adds people and says which lines need fixing", async () => {
  const cookie = await signIn();
  const res = await post("/people/import", { list: "Name\tBirthday\nAnu Joseph\t30-09-1996\nBiju\t09-30\nAnu Joseph\t30/09" }, { cookie });
  assert.equal(res.status, 422);
  const page = await res.text();
  assert.match(page, /Added 1 birthday and 0 anniversaries/);
  assert.match(page, /1 already on the list was skipped/);
  assert.match(page, /Line 3: Biju/);
});

test("the People table saves numbers, destinations and messages — all or nothing", async () => {
  const cookie = await signIn();
  const a = db.people.create({ name: "Table A", day: 3, month: 3 });
  const b = db.people.create({ name: "Table B", day: 4, month: 4 });
  const rows = (bPhone) => [
    ["id", String(a)], [`phone_${a}`, "98765 43210"], [`send_to_${a}`, "direct"], [`message_${a}`, "Happy birthday, {first_name}!"],
    ["id", String(b)], [`phone_${b}`, bPhone], [`send_to_${b}`, "direct"], [`message_${b}`, ""],
  ];

  const refused = await post("/people/save", rows("12"), { cookie });
  assert.equal(refused.status, 422);
  const page = await refused.text();
  assert.match(page, /“12” is not a phone number/);
  assert.match(page, /value="98765 43210"/); // what was typed stays on the page
  assert.equal(db.people.get(a).sendTo, ""); // nothing saved

  const noNumber = await post("/people/save", rows(""), { cookie });
  assert.equal(noNumber.status, 422);
  assert.match(await noNumber.text(), /Add their WhatsApp number first/);

  const saved = await post("/people/save", rows("+91 98765 00000"), { cookie });
  assert.equal(saved.status, 303);
  assert.deepEqual([db.people.get(a).phone, db.people.get(a).sendTo, db.people.get(a).message], ["919876543210", "direct", "Happy birthday, {first_name}!"]);
  assert.equal(db.people.get(b).phone, "919876500000");
});

test("a row's Send now saves the table first, then says why it could not send", async () => {
  const cookie = await signIn();
  const id = db.people.create({ name: "Row Sender", day: 5, month: 5, sendTo: "120363000000000009@g.us" });
  const res = await post(
    "/people/save",
    [["id", String(id)], [`phone_${id}`, ""], [`send_to_${id}`, "120363000000000009@g.us"], [`time_${id}`, "21:15"], [`message_${id}`, "Hi"], ["send", String(id)]],
    { cookie },
  );
  assert.equal(res.status, 303);
  assert.deepEqual([db.people.get(id).sendTime, db.people.get(id).message], ["21:15", "Hi"]);
  const flash = JSON.parse(Buffer.from(/bdr_flash=([^;]+)/.exec(res.headers.get("set-cookie"))[1], "base64url").toString());
  assert.equal(flash.type, "error");
  assert.match(flash.text, /Saved, but Row Sender’s wish was not sent: WhatsApp is not connected/);

  const badTime = await post("/people/save", [["id", String(id)], [`time_${id}`, "25:00"], [`send_to_${id}`, ""]], { cookie });
  assert.equal(badTime.status, 422);
  assert.match(await badTime.text(), /Enter a time like 09:30/);
});

test("an anniversary is added from its own link, and a duplicate is refused", async () => {
  const cookie = await signIn();
  const form = await (await get("/people/new?kind=anniversary", cookie)).text();
  assert.match(form, /<h1>Add anniversary<\/h1>/);
  assert.match(form, /value="anniversary" data-kind-for="wish-preview" checked/);
  const fields = { kind: "anniversary", name: "Joseph & Mary", day: "15", month: "5", year: "1995", active: "1" };
  assert.equal((await post("/people", fields, { cookie })).status, 303);
  const person = db.people.all().find((p) => p.name === "Joseph & Mary");
  assert.equal(person.kind, "anniversary");
  const again = await post("/people", fields, { cookie });
  assert.equal(again.status, 422);
  assert.match(await again.text(), /already on the list with this anniversary/);
  assert.equal((await post("/people", { ...fields, kind: "birthday" }, { cookie })).status, 303, "a birthday on the same date is another occasion");
});

test("the default messages can be edited from the People page", async () => {
  const cookie = await signIn();
  const res = await post("/settings/messages", { template: "Happy birthday, {first_name}!", anniversaryTemplate: "" }, { cookie });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/people?defaults#default-messages");
  assert.equal(db.settings.get().template, "Happy birthday, {first_name}!");
  assert.match(db.settings.get().anniversaryTemplate, /^💍 Happy anniversary/, "empty restores the original");
  const page = await (await get("/people?defaults", cookie)).text();
  assert.match(page, /<details class="card defaults" id="default-messages" open>/);
  // Each row's empty message offers the default with the person's name in.
  const id = db.people.create({ name: "Vivek Paul", day: 8, month: 8 });
  const table = await (await get("/people", cookie)).text();
  assert.match(table, new RegExp(`name="message_${id}"[^>]*data-default-message="Happy birthday, Vivek!"`));
});

test("WhatsApp lives in Settings now; the app is called Wish Calendar", async () => {
  const cookie = await signIn();
  const old = await get("/whatsapp", cookie);
  assert.equal(old.status, 303);
  assert.equal(old.headers.get("location"), "/settings#whatsapp");
  const page = await (await get("/settings", cookie)).text();
  assert.match(page, /<title>Settings · Wish Calendar<\/title>/);
  assert.match(page, /<section class="card whatsapp" id="whatsapp" data-wa-state="idle"/);
  assert.match(page, /Link a phone/);
  assert.doesNotMatch(page, /href="\/whatsapp"/, "no menu entry for a WhatsApp page");
});

test("Change password: the current one first; then the old sessions and the old password are over", async () => {
  const flashOf = (res) => JSON.parse(Buffer.from(/bdr_flash=([^;]+)/.exec(res.headers.getSetCookie().find((c) => c.startsWith("bdr_flash=")))[1], "base64url").toString()).text;
  const before = await signIn();
  const change = (fields, address = "10.0.0.50") => post("/settings/password", fields, { cookie: before, address });

  assert.match(flashOf(await change({ current: "wrong", next: "brand new one", again: "brand new one" })), /current password is not right/);
  assert.match(flashOf(await change({ current: PASSWORD, next: "short", again: "short" })), /needs 8 to 200 characters/);
  assert.match(flashOf(await change({ current: PASSWORD, next: "brand new one", again: "brand new two" })), /not the same/);
  assert.equal(db.password.hash(), null, "nothing changed so far");

  const done = await change({ current: PASSWORD, next: "brand new one", again: "brand new one" });
  assert.equal(done.status, 303);
  assert.match(flashOf(done), /Password changed. Every other browser is signed out./);
  const after = done.headers.getSetCookie().find((c) => c.startsWith("bdr_session=")).split(";")[0];
  assert.match(db.password.hash(), /^scrypt:/);

  assert.equal((await get("/", before)).status, 303, "the old session is signed out");
  assert.equal((await get("/", after)).status, 200, "this browser stays signed in");
  assert.equal((await post("/login", { password: PASSWORD }, { address: "10.0.0.51" })).status, 401);
  assert.equal((await post("/login", { password: "brand new one" }, { address: "10.0.0.51" })).status, 303);

  db.password.clear(); // what scripts/reset-password.sh does
  assert.equal((await get("/", after)).status, 303);
  assert.equal((await post("/login", { password: PASSWORD }, { address: "10.0.0.51" })).status, 303);
});

test("Settings says plainly what the sending switch does", async () => {
  const page = await (await get("/settings", await signIn())).text();
  assert.match(page, /Send wishes and reminders automatically/);
  assert.match(page, /Unticked, the app pauses/);
  assert.match(page, /<section class="card" id="password"/);
});

test("a row's Delete saves the table, then deletes that row only", async () => {
  const cookie = await signIn();
  const keep = db.people.create({ name: "Keep Me", day: 9, month: 9 });
  const gone = db.people.create({ name: "Delete Me", day: 10, month: 9 });
  const res = await post(
    "/people/save",
    [["id", String(keep)], [`message_${keep}`, "Saved first"], ["id", String(gone)], ["delete", String(gone)]],
    { cookie },
  );
  assert.equal(res.status, 303);
  assert.equal(db.people.get(gone), null);
  assert.equal(db.people.get(keep).message, "Saved first");
  const table = await (await get("/people", cookie)).text();
  assert.match(table, new RegExp(`name="delete" value="${keep}"[^>]*data-confirm="Delete Keep Me’s birthday`));
});

test("the reminder to my number needs my number", async () => {
  const cookie = await signIn();
  const base = { wishTime: "08:00", reminderTime: "07:00", timezone: "Asia/Kolkata", daysAhead: "1", countryCode: "91", template: "" };
  const refused = await post("/settings", { ...base, reminderTo: "direct", myPhone: "" }, { cookie });
  assert.equal(refused.status, 422);
  assert.match(await refused.text(), /Add your WhatsApp number first/);
  const saved = await post("/settings", { ...base, reminderTo: "direct", myPhone: "98765 11111" }, { cookie });
  assert.equal(saved.status, 303);
  assert.deepEqual([db.settings.get().reminderTo, db.settings.get().myPhone], ["direct", "919876511111"]);
});

test("the stylesheet is cached for good only at its hashed address", async () => {
  const page = await (await get("/login")).text();
  const href = /href="(\/static\/style\.css\?v=[0-9a-f]+)"/.exec(page)[1];
  assert.match((await get(href)).headers.get("cache-control"), /immutable/);
  assert.equal((await get("/static/style.css")).headers.get("cache-control"), "no-cache");
  // Only the three files it was given, by name: nothing else under the app.
  assert.equal((await get("/static/main.mjs")).status, 404);
  assert.equal((await get("/static/..%2Fsrc%2Fmain.mjs")).status, 404);
});

test("without its secrets the app serves only the setup page", async () => {
  const scheduler = createScheduler({ db, bridge: fakeBridge, log: silentLog });
  const bare = await createApp({ config: {}, problems: ["ADMIN_PASSWORD is missing."], db, bridge: fakeBridge, scheduler, log: silentLog });
  await new Promise((resolve) => bare.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${bare.address().port}/`);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /ADMIN_PASSWORD is missing/);
  } finally {
    bare.close();
  }
});

test("Settings: where alerts go, a test alert that says why it did not go, and alerts on the Today page", async () => {
  const cookie = await signIn();
  const flashOf = (res) => JSON.parse(Buffer.from(/bdr_flash=([^;]+)/.exec(res.headers.getSetCookie().find((c) => c.startsWith("bdr_flash=")))[1], "base64url").toString()).text;
  const base = { wishTime: "08:00", reminderTime: "07:00", timezone: "Asia/Kolkata", daysAhead: "1", countryCode: "91", template: "", reminderTo: "", myPhone: "" };

  const page = await (await get("/settings", cookie)).text();
  assert.match(page, /<fieldset class="settings-group" id="alerts">/);
  assert.match(page, /<select name="alertTo"[^>]*><option value=""[^>]*>No one — no alerts<\/option><option value="self"/);
  assert.match(page, /<button type="submit" form="test-alert"[^>]*data-confirm="Send a test alert now/);
  assert.match(page, /<form method="post" action="\/settings\/test-alert" id="test-alert" hidden><\/form>/);

  // Saved from a page opened before alerts existed: they stay as they were.
  db.settings.save({ alertTo: "self" });
  assert.equal((await post("/settings", base, { cookie })).status, 303);
  assert.equal(db.settings.get().alertTo, "self");

  const refused = await post("/settings", { ...base, alertTo: "direct" }, { cookie });
  assert.equal(refused.status, 422);
  assert.match(await refused.text(), /Add your WhatsApp number first/);

  // Sending off, then on: days it was off are not looked back over.
  assert.equal((await post("/settings", { ...base, alertTo: "self" }, { cookie })).status, 303);
  db.alerts.setCheckedThrough("2026-01-01");
  assert.equal((await post("/settings", { ...base, alertTo: "self", enabled: "1" }, { cookie })).status, 303);
  const yesterday = isoDate(addDays(zonedNow(new Date(), "Asia/Kolkata"), -1));
  assert.equal(db.alerts.checkedThrough(), yesterday);
  assert.equal(db.settings.get().alertTo, "self");

  // WhatsApp is not linked in these tests: the test alert is not sent, and says why.
  const test = await post("/settings/test-alert", {}, { cookie });
  assert.equal(test.status, 303);
  assert.equal(test.headers.get("location"), "/settings");
  assert.match(flashOf(test), /^The test alert was not sent: WhatsApp is not connected/);

  db.alerts.create({ key: "alert:missed:2026-01-02", day: "2026-01-03", text: "⚠️ *Wish Calendar: a wish was not sent on Fri 2 Jan*" }, new Date().toISOString());
  const today = await (await get("/", cookie)).text();
  assert.match(today, /alerts to the linked phone/);
  assert.match(today, /<td>Alert: a wish was not sent on Fri 2 Jan<\/td>\s*<td>—<\/td>\s*<td><span class="tick tick--due" aria-hidden="true">◷<\/span> Waiting to be sent<\/td>/);

  assert.equal((await post("/settings", { ...base, alertTo: "" }, { cookie })).status, 303);
  assert.match(await (await get("/", cookie)).text(), /Paused — nothing goes out on its own/);
});

test("notes: write one, find it, change it, pin it, delete it", async () => {
  const cookie = await signIn();
  assert.match(await (await get("/notes", cookie)).text(), /<a href="\/notes" aria-current="page">Notes<\/a>/);
  assert.equal((await post("/notes", { title: "", body: "   " }, { cookie })).status, 422, "an empty note is not saved");

  const created = await post("/notes", { title: "", body: "Dentist on Tuesday at 10:00 #Health\nBring the X-rays." }, { cookie });
  assert.equal(created.status, 303);
  const path = created.headers.get("location");
  assert.match(path, /^\/notes\/\d+$/);
  const page = await (await get(path, cookie)).text();
  assert.match(page, /<h1 class="note__title">Dentist on Tuesday at 10:00 #Health<\/h1>/, "no title: the first line is one");
  assert.match(page, /<div class="note__body">Bring the X-rays.<\/div>/);

  const found = await (await get("/notes?q=dent+x-ray", cookie)).text();
  assert.match(found, /1 match for “dent x-ray”/);
  assert.match(found, /<mark>Dentist<\/mark>/);
  assert.match(await (await get("/notes?tag=health", cookie)).text(), /#health <span class="muted">· 1 note<\/span>/);

  const id = Number(path.split("/").pop());
  assert.equal((await post(path, { title: "Dentist", body: "Moved to Wednesday", pinned: "1" }, { cookie })).status, 303);
  assert.deepEqual([db.notes.get(id).title, db.notes.get(id).body, db.notes.get(id).pinned, db.notes.get(id).tags], ["Dentist", "Moved to Wednesday", true, []]);
  assert.equal((await post(`${path}/pin`, { pinned: "0" }, { cookie })).status, 303);
  assert.equal(db.notes.get(id).pinned, false);

  assert.equal((await post(`${path}/delete`, {}, { cookie })).status, 303);
  assert.equal(db.notes.get(id), null);
  assert.equal((await get(path, cookie)).status, 404);
});

test("a note shows its text as text: only tags and http(s) links become links", async () => {
  const cookie = await signIn();
  const res = await post("/notes", { title: "<img src=x onerror=alert(1)>", body: "<script>alert(1)</script> javascript:alert(1) https://example.com/a?b=1&c=2 #tag" }, { cookie });
  const page = await (await get(res.headers.get("location"), cookie)).text();
  assert.ok(page.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt; javascript:alert(1) "));
  assert.ok(!page.includes("<script>alert(1)"));
  assert.ok(page.includes('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">'));
  assert.ok(page.includes('<a class="tag" href="/notes?tag=tag">#tag</a>'));
});

test("search never fails, whatever is typed", async () => {
  const cookie = await signIn();
  for (const q of ['"', "NEAR(", "title:x", "*", "a AND", "-", "^x", "'; DROP TABLE notes; --", "%", "😀"]) {
    const res = await get(`/notes?q=${encodeURIComponent(q)}`, cookie);
    assert.equal(res.status, 200, q);
  }
  assert.equal((await get("/notes?tag=%22%3E%3Cscript%3E", cookie)).status, 200, "a tag that cannot be one is ignored");
});

test("the journal: today's page from Today, any real day, and no such day", async () => {
  const cookie = await signIn();
  const today = isoDate(zonedNow(new Date(), db.settings.get().timezone));
  const home = await (await get("/", cookie)).text();
  assert.match(home, new RegExp(`<form method="post" action="/journal/${today}" class="form journal-card__form" data-unsaved>`));

  const fromToday = await post(`/journal/${today}`, { back: "today", body: "Coffee with Tom #catchup" }, { cookie });
  assert.equal(fromToday.headers.get("location"), "/");
  assert.equal(db.journal.get(today).body, "Coffee with Tom #catchup");
  assert.match(await (await get("/", cookie)).text(), /Coffee with Tom #catchup<\/textarea>/);

  assert.equal((await get("/journal", cookie)).headers.get("location"), `/journal/${today}`);
  const page = await (await get(`/journal/${today}`, cookie)).text();
  assert.match(page, /— today<\/p>/);
  assert.match(page, /Coffee with Tom #catchup<\/textarea>/);

  assert.equal((await post("/journal/2026-01-31", { body: "Elsewhere" }, { cookie })).headers.get("location"), "/journal/2026-01-31");
  assert.equal((await get("/journal/2026-02-30", cookie)).status, 404);
  assert.equal((await post("/journal/2026-13-01", { body: "x" }, { cookie })).status, 404);

  assert.equal((await post(`/journal/${today}`, { body: "" }, { cookie })).status, 303);
  assert.equal(db.journal.get(today), null, "saved empty, the page is gone");
});

test("a note about someone is on their page, and outlives them on the list", async () => {
  const cookie = await signIn();
  const id = db.people.create({ name: "Noted Person", day: 11, month: 11 });
  const form = await (await get(`/notes/new?person=${id}`, cookie)).text();
  assert.match(form, new RegExp(`<option value="${id}" selected>🎂 Noted Person</option>`));
  const res = await post("/notes", { title: "Likes jazz", body: "", person: String(id) }, { cookie });
  const noteId = Number(res.headers.get("location").split("/").pop());
  assert.match(await (await get(`/people/${id}`, cookie)).text(), new RegExp(`Notes about Noted Person[\\s\\S]*<a href="/notes/${noteId}">Likes jazz</a>`));
  db.people.remove(id);
  const page = await (await get(`/notes/${noteId}`, cookie)).text();
  assert.match(page, /Likes jazz/);
  assert.doesNotMatch(page, /About <a href="\/people/);
});

test("the calendar: the month, a day in full, and Your day on Today", async () => {
  const cookie = await signIn();
  const today = isoDate(zonedNow(new Date(), db.settings.get().timezone));
  const month = today.slice(0, 7);
  const id = db.events.create({ title: "Calendar test event", day: today, time: "23:58", remind: 0 });
  db.tasks.create({ title: "Calendar test task", due: today });
  const page = await (await get("/calendar", cookie)).text();
  assert.match(page, /<a href="\/calendar" aria-current="page">Calendar<\/a>/);
  assert.match(page, /<main class="page page--wide">/);
  assert.match(page, new RegExp(`<a class="cal__num" href="/calendar\\?month=${month}&amp;day=${today}"[^>]*aria-current="date"`));
  assert.match(page, new RegExp(`<a href="/events/${id}">Calendar test event</a>`));
  assert.match(page, /Calendar test task/);
  assert.equal((await get("/calendar?month=2026-13", cookie)).status, 200, "a month that is not one shows this month");
  assert.match(await (await get("/calendar?month=2027-02&day=2027-02-14", cookie)).text(), /Sunday 14 February 2027/);

  const home = await (await get("/", cookie)).text();
  assert.match(home, /<h2 id="your-day-title">Your day<\/h2>/);
  assert.match(home, /23:58<\/span>\s*<span><a href="\/events\/\d+">Calendar test event<\/a> <span class="muted">· reminder at the time<\/span>/);
  assert.match(home, /Reminder: <strong>Calendar test event<\/strong>/, "Today's messages list the reminder");
  db.events.remove(id);
});

test("an event is checked before it is saved, and can be changed and deleted", async () => {
  const cookie = await signIn();
  const base = { title: "Dentist", day: "2026-11-03", endDay: "", time: "10:00", endTime: "10:45", repeat: "", repeatUntil: "", remind: "60", notes: "" };
  const refused = async (fields, message) => {
    const res = await post("/events", { ...base, ...fields }, { cookie });
    assert.equal(res.status, 422, message.source);
    assert.match(await res.text(), message);
  };
  await refused({ title: "" }, /Say what it is/);
  await refused({ day: "2026-02-30" }, /Pick the day/);
  await refused({ endDay: "2026-11-01" }, /before the day it starts/);
  await refused({ endTime: "09:00" }, /not after it starts/);
  await refused({ repeat: "weekly", repeatUntil: "2026-10-01" }, /before the day it starts/);
  await refused({ remind: "45" }, /Choose a reminder from the list/);
  assert.equal((await post("/events", { ...base, title: "All day", time: "", endTime: "", remind: "5" }, { cookie })).status, 303);
  assert.equal(db.events.between("2026-11-03", "2026-11-03").find((e) => e.title === "All day").remind, null, "minutes before an all-day event: not kept");

  const created = await post("/events", base, { cookie });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get("location"), "/calendar?month=2026-11&day=2026-11-03");
  const event = db.events.between("2026-11-03", "2026-11-03").find((e) => e.title === "Dentist");
  assert.deepEqual([event.time, event.endTime, event.remind, event.endDay, event.repeat], ["10:00", "10:45", 60, null, ""]);

  const form = await (await get(`/events/${event.id}`, cookie)).text();
  assert.match(form, /<option value="60" selected>1 hour before<\/option>/);
  const trip = { ...base, title: "Trip", day: "2026-11-10", endDay: "2026-11-13", time: "", endTime: "", remind: "1440", repeat: "yearly" };
  assert.equal((await post(`/events/${event.id}`, trip, { cookie })).status, 303);
  assert.deepEqual([db.events.get(event.id).endDay, db.events.get(event.id).remind, db.events.get(event.id).repeat], ["2026-11-13", 1440, "yearly"]);

  assert.equal((await post(`/events/${event.id}/delete`, {}, { cookie })).status, 303);
  assert.equal(db.events.get(event.id), null);
  assert.equal((await get(`/events/${event.id}`, cookie)).status, 404);
});

test("tasks: added, ticked, changed and deleted — and sent back only to the app's own pages", async () => {
  const cookie = await signIn();
  const flashOf = (res) => JSON.parse(Buffer.from(/bdr_flash=([^;]+)/.exec(res.headers.get("set-cookie"))[1], "base64url").toString()).text;
  const added = await post("/tasks", { title: "Renew passport", due: "2026-11-20", back: "/calendar?month=2026-11&day=2026-11-20" }, { cookie });
  assert.equal(added.headers.get("location"), "/calendar?month=2026-11&day=2026-11-20");
  assert.match(flashOf(added), /Added “Renew passport” — due Fri 20 Nov/);
  const task = db.tasks.open().find((t) => t.title === "Renew passport");

  for (const back of ["https://example.com/", "//example.com", "/calendar?month=2026-11&next=//example.com", "/\\example.com"]) {
    assert.equal((await post(`/tasks/${task.id}/done`, { done: "1", back }, { cookie })).headers.get("location"), "/calendar", back);
  }
  assert.equal(db.tasks.get(task.id).done, true);
  assert.equal((await post(`/tasks/${task.id}/done`, { done: "0", back: "/" }, { cookie })).headers.get("location"), "/");
  assert.equal(db.tasks.get(task.id).done, false);

  assert.match(flashOf(await post("/tasks", { title: "  ", back: "/" }, { cookie })), /not added: Say what it is/);
  assert.match(flashOf(await post("/tasks", { title: "Bad day", due: "2026-02-31", back: "/" }, { cookie })), /that due day is not a day/);

  assert.equal((await post(`/tasks/${task.id}`, { title: "Renew passport", due: "", notes: "Photos first", done: "1" }, { cookie })).status, 303);
  assert.deepEqual([db.tasks.get(task.id).due, db.tasks.get(task.id).notes, db.tasks.get(task.id).done], [null, "Photos first", true]);
  assert.equal((await post(`/tasks/${task.id}/delete`, {}, { cookie })).status, 303);
  assert.equal(db.tasks.get(task.id), null);
});

test("Settings: calendar messages go to the linked phone unless changed, apart from the wishes' reminder", async () => {
  const cookie = await signIn();
  const page = await (await get("/settings", cookie)).text();
  assert.match(page, /<fieldset class="settings-group" id="calendar">/);
  assert.match(page, /<select name="calendarTo"[^>]*><option value=""[^>]*>Nowhere — no calendar messages<\/option><option value="self" selected>/);
  const base = { wishTime: "08:00", reminderTime: "07:00", timezone: "Asia/Kolkata", daysAhead: "1", countryCode: "91", template: "", reminderTo: "", myPhone: "", alertTo: "self" };
  assert.equal((await post("/settings", base, { cookie })).status, 303);
  assert.equal(db.settings.get().calendarTo, "self", "a page without the field keeps it");
  const refused = await post("/settings", { ...base, calendarTo: "direct" }, { cookie });
  assert.equal(refused.status, 422);
  assert.equal((await post("/settings", { ...base, calendarTo: "" }, { cookie })).status, 303);
  assert.equal(db.settings.get().calendarTo, "");
  db.settings.save({ calendarTo: "self" });
});

test("Settings: 📅 messages from WhatsApp go on the calendar unless switched off", async () => {
  const cookie = await signIn();
  const page = await (await get("/settings", cookie)).text();
  assert.match(page, /<input type="checkbox" name="capture" value="1" checked> <span><strong>Add to the calendar from WhatsApp<\/strong>/);
  const base = { wishTime: "08:00", reminderTime: "07:00", timezone: "Asia/Kolkata", daysAhead: "1", countryCode: "91", template: "", reminderTo: "", myPhone: "", alertTo: "self", calendarTo: "self" };
  assert.equal((await post("/settings", base, { cookie })).status, 303);
  assert.equal(db.settings.get().capture, true, "a page from before the switch keeps it");
  assert.equal((await post("/settings", { ...base, captureShown: "1" }, { cookie })).status, 303);
  assert.equal(db.settings.get().capture, false, "unticked");
  assert.equal((await post("/settings", { ...base, captureShown: "1", capture: "1" }, { cookie })).status, 303);
  assert.equal(db.settings.get().capture, true);
  db.settings.save({ captureChats: ["self"] }); // those posts ticked no chat
});

test("Settings: where 📅 messages count, and the reminder new events start with", async () => {
  const cookie = await signIn();
  const page = await (await get("/settings", cookie)).text();
  assert.match(page, /<input type="checkbox" name="captureChat" value="self" checked> <span>Message yourself/, "Message yourself, unless changed");
  assert.match(page, /<select name="defaultRemind"[^>]*>.*<option value="5" selected>5 minutes before<\/option>/s);
  assert.match(await (await get("/events/new", cookie)).text(), /<option value="5" selected>5 minutes before<\/option>/, "a new event starts with it");
  const base = { wishTime: "08:00", reminderTime: "07:00", timezone: "Asia/Kolkata", daysAhead: "1", countryCode: "91", template: "", reminderTo: "", myPhone: "", alertTo: "self", calendarTo: "self", captureShown: "1", capture: "1" };
  const group = "120363000000000042@g.us";
  const saved = await post("/settings", [...Object.entries(base), ["captureChat", group], ["captureChat", "self"], ["captureChat", "not-a-chat"], ["defaultRemind", "10"]], { cookie });
  assert.equal(saved.status, 303);
  assert.deepEqual([db.settings.get().captureChats.sort(), db.settings.get().defaultRemind], [[group, "self"], 10]);
  assert.match(await (await get("/settings", cookie)).text(), new RegExp(`value="${group}" checked> <span>A group the number has left`), "kept in view, though not listed");
  assert.equal((await post("/settings", [...Object.entries(base), ["defaultRemind", "7"]], { cookie })).status, 422);
  assert.equal((await post("/settings", [...Object.entries(base), ["defaultRemind", ""]], { cookie })).status, 303);
  assert.deepEqual([db.settings.get().captureChats, db.settings.get().defaultRemind], [[], null], "nothing ticked: nowhere; no reminder");
  db.settings.save({ captureChats: ["self"], defaultRemind: 5 });
});
