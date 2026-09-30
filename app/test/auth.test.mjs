import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuth, hashPassword, verifyPassword } from "../src/auth.mjs";

test("a password is kept as a salted scrypt hash, and checked against it", () => {
  const stored = hashPassword("correct horse");
  assert.match(stored, /^scrypt:32768:8:1:[\w-]{22}:[\w-]{43}$/);
  assert.notEqual(stored, hashPassword("correct horse"), "a new salt every time");
  assert.equal(verifyPassword("correct horse", stored), true);
  assert.equal(verifyPassword("correct hors", stored), false);
  assert.equal(verifyPassword("anything", "not-a-hash"), false);
});

test("the password set in Settings replaces the .env one, and ends every session", () => {
  let hash = null;
  const store = { hash: () => hash, set: (h) => (hash = h) };
  const auth = createAuth({ password: "from the env file", secret: "s".repeat(40), store });
  const before = auth.issue();
  assert.equal(auth.checkPassword("from the env file"), true);
  auth.setPassword("from settings!");
  assert.equal(auth.checkPassword("from the env file"), false);
  assert.equal(auth.checkPassword("from settings!"), true);
  assert.equal(auth.verify(before), false, "sessions from before the change are over");
  assert.equal(auth.verify(auth.issue()), true);
  hash = null; // scripts/reset-password.sh
  assert.equal(auth.checkPassword("from the env file"), true);
  assert.equal(auth.verify(before), true, "with the .env password back, so is its key");
});

test("sessions from before this version still work (the same key while no password is set)", () => {
  const auth = createAuth({ password: "from the env file", secret: "s".repeat(40) });
  assert.equal(auth.verify(auth.issue()), true);
});
