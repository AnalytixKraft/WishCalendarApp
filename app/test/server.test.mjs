import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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
