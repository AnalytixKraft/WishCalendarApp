/* The Import page: a list pasted from a spreadsheet (tab-separated) or a CSV
 * file's text, one person per line:
 *
 *   name, birthday[, groups][, notes]
 *
 * with an optional header row. Birthdays are read DAY FIRST, as they are
 * written in India: 30-09, 30/09/1996, 30.9.1996, 1996-09-30, 30 Sep,
 * 30 September 1996, Sep 30, September 30, 1996. Groups are names, separated
 * by ; or |. */

import { MONTHS, daysInMonth, isValidDayMonth } from "./dates.mjs";

export const MAX_ROWS = 2_000;

const MONTH_BY_PREFIX = new Map(MONTHS.map((name, i) => [name.slice(0, 3).toLowerCase(), i + 1]));
const HEADER_ALIASES = {
  name: ["name", "full name", "person"],
  birthday: ["birthday", "birth date", "date of birth", "dob", "date"],
  groups: ["groups", "group", "whatsapp group", "whatsapp groups"],
  notes: ["notes", "note", "remarks", "comment", "comments"],
};

/* RFC 4180-ish: quoted fields may hold the delimiter, newlines and "" for a
 * quote. Each row carries the line it started on, for error messages. */
export function parseDelimited(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = ["\t", ";", ","]
    .map((d) => [d, firstLine.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push({ line: rowLine, cells: row });
      row = [];
      field = "";
      line++;
      rowLine = line;
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push({ line: rowLine, cells: row });
  }
  return rows
    .map((r) => ({ line: r.line, cells: r.cells.map((cell) => cell.trim()) }))
    .filter((r) => r.cells.some((cell) => cell !== ""));
}

const monthFromName = (word) => MONTH_BY_PREFIX.get(word.slice(0, 3).toLowerCase()) ?? null;

/* → {day, month, year|null} or {error}. */
export function parseBirthday(input) {
  const s = input.trim().replace(/\s+/g, " ").replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  let day, month, year = null, m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    [year, month, day] = [+m[1], +m[2], +m[3]];
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/.exec(s))) {
    [day, month] = [+m[1], +m[2]];
    if (m[3] !== undefined) {
      if (m[3].length !== 4) return { error: `use a four-digit year in "${input}"` };
      year = +m[3];
    }
  } else if ((m = /^(\d{1,2})[ -]([A-Za-z]{3,})\.?,?(?:[ -](\d{4}))?$/.exec(s))) {
    [day, month, year] = [+m[1], monthFromName(m[2]), m[3] ? +m[3] : null];
  } else if ((m = /^([A-Za-z]{3,})\.? (\d{1,2}),?(?: (\d{4}))?$/.exec(s))) {
    [month, day, year] = [monthFromName(m[1]), +m[2], m[3] ? +m[3] : null];
  } else {
    return { error: `"${input}" is not a date this page reads — write it day first, like 30-09-1996 or 30 Sep` };
  }
  if (!month) return { error: `"${input}" has no month this page knows` };
  if (!isValidDayMonth(day, month) || (year !== null && day > daysInMonth(year, month))) {
    return { error: `"${input}" is not a real date — birthdays are read day first (30-09, not 09-30)` };
  }
  if (year !== null && (year < 1900 || year > new Date().getUTCFullYear())) {
    return { error: `the year in "${input}" is out of range` };
  }
  return { day, month, year };
}

function columnsOf(header) {
  const columns = {};
  header.forEach((cell, index) => {
    const label = cell.toLowerCase();
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (columns[key] === undefined && aliases.includes(label)) columns[key] = index;
    }
  });
  return columns.name !== undefined && columns.birthday !== undefined ? columns : null;
}

/* → {people: [{line, name, day, month, year, groupNames|null, notes}], errors: [{line, message}]}.
 * groupNames is null when the row names none — the caller picks the default. */
export function parsePeople(text) {
  const rows = parseDelimited(text);
  const errors = [];
  const people = [];
  if (!rows.length) return { people, errors };
  const header = columnsOf(rows[0].cells);
  const columns = header ?? { name: 0, birthday: 1, groups: 2, notes: 3 };
  const body = header ? rows.slice(1) : rows;
  if (body.length > MAX_ROWS) {
    return { people, errors: [{ line: null, message: `at most ${MAX_ROWS} people at a time` }] };
  }
  for (const { line, cells } of body) {
    const cell = (key) => (columns[key] === undefined ? "" : cells[columns[key]] ?? "");
    const name = cell("name");
    if (!name) {
      errors.push({ line, message: "no name" });
      continue;
    }
    if (name.length > 100) {
      errors.push({ line, message: "the name is longer than 100 characters" });
      continue;
    }
    if (!cell("birthday")) {
      errors.push({ line, message: `no birthday for ${name}` });
      continue;
    }
    const birthday = parseBirthday(cell("birthday"));
    if (birthday.error) {
      errors.push({ line, message: `${name}: ${birthday.error}` });
      continue;
    }
    const groups = cell("groups");
    people.push({
      line,
      name,
      ...birthday,
      groupNames: groups ? groups.split(/[;|]/).map((g) => g.trim()).filter(Boolean) : null,
      notes: cell("notes").slice(0, 500),
    });
  }
  return { people, errors };
}
