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

test("a pasted spreadsheet: tabs, a header row, groups and notes", () => {
  const text = "Name\tBirthday\tGroups\tNotes\nAnu Joseph\t30-09-1996\tYouth; Choir\tLeads the choir\nBiju Thomas\t5 Oct\t\t\n";
  const { people, errors } = parsePeople(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(people, [
    { line: 2, name: "Anu Joseph", day: 30, month: 9, year: 1996, groupNames: ["Youth", "Choir"], notes: "Leads the choir" },
    { line: 3, name: "Biju Thomas", day: 5, month: 10, year: null, groupNames: null, notes: "" },
  ]);
});

test("a CSV without a header, quoted commas, and the lines that need fixing", () => {
  const text = [
    '"Joseph, Anu",30/09/1996',
    "Biju Thomas,09-30",
    ",1 Jan",
    "Mary K,",
    "",
    'Jose "JP" P,3 Oct,Youth',
  ].join("\r\n");
  const { people, errors } = parsePeople(text);
  assert.deepEqual(people.map((p) => [p.line, p.name, p.day, p.month]), [
    [1, "Joseph, Anu", 30, 9],
    [6, 'Jose "JP" P', 3, 10],
  ]);
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4]);
});

test("line numbers survive a quoted field that spans lines", () => {
  const rows = parseDelimited('name,notes\n"Anu","two\nlines"\nBiju,x');
  assert.deepEqual(rows.map((r) => r.line), [1, 2, 4]);
  assert.equal(rows[1].cells[1], "two\nlines");
});
