/* The Upload page: a CSV file, or rows pasted from a spreadsheet
 * (tab-separated), one person (or couple) per line:
 *
 *   name, birthday[, WhatsApp number][, send to][, message][, notes][, time]
 *
 * With a header row the columns can come in any order, and a row can carry an
 * anniversary too: a Birthday and an Anniversary column on one row add both
 * occasions; a Date column with an Occasion column adds one of either kind.
 * Dates are read DAY FIRST, as they are written in India: 30-09, 30/09/1996,
 * 30.9.1996, 1996-09-30, 30 Sep, 30 September 1996, Sep 30, September 30,
 * 1996. "Send to" is a group's name, or a word like "direct" for the
 * person's own number; left empty, it is chosen on the People page. */

import { MONTHS, daysInMonth, isValidDayMonth } from "./dates.mjs";
import { normalizePhone } from "./phone.mjs";

export const MAX_ROWS = 2_000;

const MONTH_BY_PREFIX = new Map(MONTHS.map((name, i) => [name.slice(0, 3).toLowerCase(), i + 1]));
const HEADER_ALIASES = {
  name: ["name", "names", "full name", "person", "couple"],
  birthday: ["birthday", "birth date", "birthdate", "date of birth", "dob", "bday", "b'day"],
  anniversary: ["anniversary", "wedding anniversary", "wedding date", "wedding day", "wedding", "marriage date", "date of marriage", "marriage anniversary"],
  date: ["date"],
  kind: ["occasion", "type", "kind", "event"],
  phone: ["whatsapp number", "whatsapp", "number", "phone", "phone number", "mobile", "mobile number", "contact"],
  sendTo: ["send to", "send wish to", "to", "destination", "group", "groups", "whatsapp group"],
  message: ["message", "wish", "wish message", "text", "birthday message"],
  anniversaryMessage: ["anniversary message", "anniversary wish"],
  notes: ["notes", "note", "remarks", "comment", "comments"],
  sendTime: ["time", "send time", "time to send", "send at", "at"],
};

/* An Occasion cell → "birthday" | "anniversary", or null when it is neither.
 * Empty is a birthday. */
export function kindOf(word) {
  const w = word.trim().toLowerCase();
  if (!w) return "birthday";
  if (/anniv|wedding|marriage|married/.test(w)) return "anniversary";
  if (/birth|bday|b'day|dob/.test(w)) return "birthday";
  return null;
}

/* "9:30", "09:30", "9.30", "9:30 pm" → "HH:MM", or null. */
export function parseClock(input) {
  const m = /^(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?$/i.exec(input.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3]?.[0].toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/* "Send to" words that mean the person's own number. */
const DIRECT_WORDS = new Set(["direct", "directly", "dm", "direct message", "personal", "person", "them", "their number", "number", "phone", "whatsapp", "individual", "private"]);

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
  const dated = columns.birthday !== undefined || columns.anniversary !== undefined || columns.date !== undefined;
  return columns.name !== undefined && dated ? columns : null;
}

/* → {people: [{line, name, kind, day, month, year, phone, sendTo, sendTime, message, notes}],
 *    errors: [{line, message}], warnings: [string]}.
 * One entry per occasion: a row with a birthday and an anniversary gives two.
 * groupsByName: lower-cased group name → group id, for the "send to" column.
 * An occasion with a problem in its date is left out (an error); a problem
 * in the number, "send to" or time leaves that part blank (a warning), since
 * all three can be set on the People page. */
export function parsePeople(text, { countryCode = "91", groupsByName = new Map() } = {}) {
  const rows = parseDelimited(text);
  const errors = [];
  const warnings = [];
  const people = [];
  if (!rows.length) return { people, errors, warnings };
  const header = columnsOf(rows[0].cells);
  const columns = header ?? { name: 0, birthday: 1, phone: 2, sendTo: 3, message: 4, notes: 5, sendTime: 6 };
  const body = header ? rows.slice(1) : rows;
  if (body.length > MAX_ROWS) {
    return { people, errors: [{ line: null, message: `at most ${MAX_ROWS} rows at a time` }], warnings };
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

    const dates = [];
    if (cell("birthday")) dates.push({ kind: "birthday", raw: cell("birthday") });
    if (cell("anniversary")) dates.push({ kind: "anniversary", raw: cell("anniversary") });
    if (cell("date")) {
      let kind = kindOf(cell("kind"));
      if (!kind) {
        warnings.push(`Line ${line}: ${name} — “${cell("kind")}” is neither a birthday nor an anniversary; added as a birthday.`);
        kind = "birthday";
      }
      dates.push({ kind, raw: cell("date") });
    }
    if (!dates.length) {
      errors.push({ line, message: `no date for ${name}` });
      continue;
    }

    let { phone, error: phoneError } = normalizePhone(cell("phone"), countryCode);
    if (phoneError) {
      warnings.push(`Line ${line}: ${name} — ${phoneError}; added without a number.`);
      phone = "";
    }

    let sendTo = "";
    const wanted = cell("sendTo").split(/[;|]/)[0].trim();
    if (wanted) {
      if (DIRECT_WORDS.has(wanted.toLowerCase())) {
        if (phone) sendTo = "direct";
        else warnings.push(`Line ${line}: ${name} — “${wanted}” needs their WhatsApp number; “Send to” left for you to choose.`);
      } else if (groupsByName.has(wanted.toLowerCase())) {
        sendTo = groupsByName.get(wanted.toLowerCase());
      } else {
        warnings.push(`Line ${line}: ${name} — the linked number is in no group called “${wanted}”; “Send to” left for you to choose.`);
      }
    }

    let sendTime = "";
    if (cell("sendTime")) {
      sendTime = parseClock(cell("sendTime")) ?? "";
      if (!sendTime) warnings.push(`Line ${line}: ${name} — “${cell("sendTime")}” is not a time like 09:30; the wish goes at the time in Settings.`);
    }

    /* The Message column is the birthday's when a row has both; an
     * Anniversary message column is the anniversary's. */
    const messageFor = (kind) => {
      if (kind === "anniversary" && cell("anniversaryMessage")) return cell("anniversaryMessage");
      if (kind === "anniversary" && dates.length > 1) return "";
      return cell("message");
    };

    for (const { kind, raw } of dates) {
      const date = parseBirthday(raw);
      if (date.error) {
        errors.push({ line, message: `${name}${kind === "anniversary" ? " (anniversary)" : ""}: ${date.error}` });
        continue;
      }
      people.push({
        line,
        name,
        kind,
        ...date,
        phone,
        sendTo,
        sendTime,
        message: messageFor(kind).replace(/\\n/g, "\n").slice(0, 2_000),
        notes: cell("notes").slice(0, 500),
      });
    }
  }
  return { people, errors, warnings };
}
