import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPhone, normalizePhone } from "../src/phone.mjs";

test("numbers as people type them all become digits with the country code", () => {
  for (const input of ["98765 43210", "+91 98765 43210", "+91-98765-43210", "09876543210", "0091 98765 43210", "(+91) 98765.43210", "919876543210"]) {
    assert.deepEqual(normalizePhone(input), { phone: "919876543210" }, input);
  }
  assert.deepEqual(normalizePhone("+1 415 555 0100"), { phone: "14155550100" });
  assert.deepEqual(normalizePhone("415 555 0100", "1"), { phone: "14155550100" });
  assert.deepEqual(normalizePhone(""), { phone: "" });
});

test("what is not a number says so", () => {
  for (const input of ["12", "phone", "+0 123 456 789", "1234567890123456"]) assert.ok(normalizePhone(input).error, input);
});

test("formatPhone", () => {
  assert.equal(formatPhone("919876543210"), "+91 98765 43210");
  assert.equal(formatPhone("14155550100"), "+14155550100");
  assert.equal(formatPhone(""), "");
});
