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
  assert.match(page, /1 person added/);
  assert.match(page, /1 was already on the list/);
  assert.match(page, /Line 3: Biju/);
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
