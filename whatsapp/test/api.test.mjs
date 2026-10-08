import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApi } from "../src/api.mjs";

const TOKEN = "t".repeat(40);
const held = [{ id: "A", chat: "self", chat_id: "447700900077@s.whatsapp.net", sent_at: "2026-10-08T09:59:00.000Z", text: "Lunch 1pm", quoted: null }];
const acked = [];
let chats = [];
/* A session that reaches no one: only the two calls these tests make. */
const session = {
  status: () => ({ state: "open" }),
  commands: () => held,
  commandChats: () => chats,
  setCommandChats: (list) => (chats = [...list].sort()),
  ackCommands: (ids) => {
    acked.push(...ids);
    return ids.length;
  },
};

let server;
let base;
before(async () => {
  server = createApi({ token: TOKEN, session });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (method, path, { body, token = TOKEN } = {}) =>
  fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

test("📅 messages: only with the token, and only the ids given back are let go", async () => {
  assert.equal((await call("GET", "/commands", { token: null })).status, 401);
  assert.equal((await call("GET", "/commands", { token: "wrong".repeat(10) })).status, 401);
  const res = await call("GET", "/commands");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { commands: held, chats: [] });
  assert.equal((await call("POST", "/commands")).status, 405);

  assert.equal((await call("POST", "/commands/ack", { body: { ids: "A" } })).status, 400);
  assert.equal((await call("POST", "/commands/ack", { body: { ids: [""] } })).status, 400);
  assert.equal((await call("POST", "/commands/ack", { body: { ids: Array(501).fill("A") } })).status, 400);
  const ok = await call("POST", "/commands/ack", { body: { ids: ["A"] } });
  assert.deepEqual(await ok.json(), { acked: 1 });
  assert.deepEqual(acked, ["A"]);
});

test("the chats 📅 messages count in: Message yourself and groups, nothing else", async () => {
  for (const bad of [{ chats: "self" }, { chats: ["447700900001@s.whatsapp.net"] }, { chats: ["self", 7] }, {}]) {
    assert.equal((await call("POST", "/commands/chats", { body: bad })).status, 400, JSON.stringify(bad));
  }
  const res = await call("POST", "/commands/chats", { body: { chats: ["self", "120363000000000001@g.us"] } });
  assert.deepEqual(await res.json(), { chats: ["120363000000000001@g.us", "self"] });
  assert.deepEqual((await (await call("GET", "/commands")).json()).chats, ["120363000000000001@g.us", "self"]);
  assert.equal((await call("POST", "/commands/chats", { body: { chats: [] }, token: null })).status, 401);
});

test("without a token configured, there are no 📅 messages to be had", async () => {
  const bare = createApi({ token: "", session: null });
  await new Promise((resolve) => bare.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${bare.address().port}/commands`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 503);
  } finally {
    bare.close();
  }
});
