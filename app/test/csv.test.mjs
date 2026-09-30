import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBirthday, parseDelimited, parsePeople } from "../src/csv.mjs";

test("birthdays are read day first, in the usual spellings", () => {
  const cases = {
    "30-09-1996": { day: 30, month: 9, year: 1996 },
    "30/09": { day: 30, month: 9, year: null },
    "30.9.1996": { day: 30, month: 9, year: 1996 },
    "1996-09-30": { day: 30, month: 9, year: 1996 },
    "30 Sep": { day: 30, month: 9, year: null },
    "30 September 1996": { day: 30, month: 9, year: 1996 },
    "30-Sep-1996": { day: 30, month: 9, year: 1996 },
    "Sep 30": { day: 30, month: 9, year: null },
    "September 30, 1996": { day: 30, month: 9, year: 1996 },
    "5th October": { day: 5, month: 10, year: null },
    "29/02": { day: 29, month: 2, year: null },
    "29-02-2000": { day: 29, month: 2, year: 2000 },
  };
  for (const [input, expected] of Object.entries(cases)) assert.deepEqual(parseBirthday(input), expected, input);
});

test("dates that are not dates are refused, with a reason", () => {
  for (const input of ["09-30", "31/04", "29-02-1995", "30/09/96", "yesterday", "30 Smarch", "30-09-1850"]) {
    assert.ok(parseBirthday(input).error, input);
  }
  assert.match(parseBirthday("09-30").error, /day first/);
  assert.match(parseBirthday("30/09/96").error, /four-digit year/);
});

const YOUTH = "120363000000000001@g.us";
const groupsByName = new Map([["st. mary's youth", YOUTH]]);

test("a pasted spreadsheet: a header row, columns in any order, number, send to and message", () => {
  const text = [
    "Birthday\tName\tWhatsApp number\tSend to\tMessage\tNotes",
    "30-09-1996\tAnu Joseph\t98765 43210\tdirect\tHappy birthday, Anu!\\nSee you Sunday\tYouth secretary",
    "5 Oct\tBiju Thomas\t\tSt. Mary's Youth\t\t",
    "6 Oct\tCara\t\t\t\t",
  ].join("\n");
  const { people, errors, warnings } = parsePeople(text, { groupsByName });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(people, [
    { line: 2, name: "Anu Joseph", kind: "birthday", day: 30, month: 9, year: 1996, phone: "919876543210", sendTo: "direct", sendTime: "", message: "Happy birthday, Anu!\nSee you Sunday", notes: "Youth secretary" },
    { line: 3, name: "Biju Thomas", kind: "birthday", day: 5, month: 10, year: null, phone: "", sendTo: YOUTH, sendTime: "", message: "", notes: "" },
    { line: 4, name: "Cara", kind: "birthday", day: 6, month: 10, year: null, phone: "", sendTo: "", sendTime: "", message: "", notes: "" },
  ]);
});

test("a CSV without a header reads name, birthday, number, send to, message; bad details become warnings", () => {
  const text = [
    '"Joseph, Anu",30/09/1996,+91 98765 43210,dm,"Many happy returns, Anu"',
    "Biju Thomas,09-30",
    ",1 Jan",
    "Mary K,",
    "",
    "Jose P,3 Oct,12345,Choir",
    "Rinu,4 Oct,,direct",
  ].join("\r\n");
  const { people, errors, warnings } = parsePeople(text, { groupsByName });
  assert.deepEqual(people.map((p) => [p.line, p.name, p.phone, p.sendTo, p.message]), [
    [1, "Joseph, Anu", "919876543210", "direct", "Many happy returns, Anu"],
    [6, "Jose P", "", "", ""],
    [7, "Rinu", "", "", ""],
  ]);
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4]);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /Line 6: Jose P — “12345” is not a phone number/);
  assert.match(warnings[1], /Line 6: Jose P — the linked number is in no group called “Choir”/);
  assert.match(warnings[2], /Line 7: Rinu — “direct” needs their WhatsApp number/);
});

test("a row with a birthday and an anniversary adds both; the Message is the birthday's", () => {
  const text = [
    "Name\tDate of birth\tWedding anniversary\tMessage\tAnniversary message",
    "Joseph & Mary\t12-03-1970\t15-05-1995\tHappy birthday, Joseph!\t",
    "Tom & Ann\t\t1 Jun 2016\t\tHappy anniversary, you two!",
    "Anu\t30-09-1996\t\t\t",
    "Nobody\t\t\t\t",
  ].join("\n");
  const { people, errors } = parsePeople(text);
  assert.deepEqual(people.map((p) => [p.line, p.kind, p.name, `${p.day}/${p.month}/${p.year}`, p.message]), [
    [2, "birthday", "Joseph & Mary", "12/3/1970", "Happy birthday, Joseph!"],
    [2, "anniversary", "Joseph & Mary", "15/5/1995", ""],
    [3, "anniversary", "Tom & Ann", "1/6/2016", "Happy anniversary, you two!"],
    [4, "birthday", "Anu", "30/9/1996", ""],
  ]);
  assert.deepEqual(errors, [{ line: 5, message: "no date for Nobody" }]);
});

test("a Date column says which occasion in an Occasion column", () => {
  const text = "Name\tDate\tOccasion\nA\t1 Jan\tBirthday\nB\t2 Jan\tWedding anniversary\nC\t3 Jan\t\nD\t4 Jan\tFeast day";
  const { people, warnings } = parsePeople(text);
  assert.deepEqual(people.map((p) => p.kind), ["birthday", "anniversary", "birthday", "birthday"]);
  assert.match(warnings[0], /Line 5: D — “Feast day” is neither a birthday nor an anniversary; added as a birthday/);
});

test("an optional Time column, in the usual spellings", () => {
  const text = "Name\tBirthday\tTime\nA\t1 Jan\t9:30 pm\nB\t2 Jan\t\nC\t3 Jan\tnoon";
  const { people, warnings } = parsePeople(text);
  assert.deepEqual(people.map((p) => p.sendTime), ["21:30", "", ""]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Line 4: C — “noon” is not a time/);
});

test("line numbers survive a quoted field that spans lines", () => {
  const rows = parseDelimited('name,notes\n"Anu","two\nlines"\nBiju,x');
  assert.deepEqual(rows.map((r) => r.line), [1, 2, 4]);
  assert.equal(rows[1].cells[1], "two\nlines");
});
