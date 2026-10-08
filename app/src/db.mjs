/* Everything the app remembers, in one SQLite file (node:sqlite, built into
 * Node 24 — no native module to build). In Docker that file is
 * /data/birthdays.db in the app_data volume.
 *
 * The schema moves forward through MIGRATIONS, counted in PRAGMA
 * user_version. Append to the list; never edit an entry that has shipped. */

import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ANNIVERSARY_TEMPLATE, DEFAULT_TEMPLATE } from "./messages.mjs";
import { tagsOf } from "./notes.mjs";

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

const MIGRATIONS = [
  `
  CREATE TABLE people (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    day        INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
    month      INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    year       INTEGER CHECK (year IS NULL OR year BETWEEN 1900 AND 2100),
    notes      TEXT    NOT NULL DEFAULT '',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW})
  );

  -- The WhatsApp groups the app posts in; id is the group's JID (…@g.us).
  -- template '' means the default wish from Settings.
  CREATE TABLE chats (
    id         TEXT    PRIMARY KEY,
    subject    TEXT    NOT NULL,
    wishes     INTEGER NOT NULL DEFAULT 1,
    reminders  INTEGER NOT NULL DEFAULT 0,
    template   TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (${NOW})
  );

  -- Who is wished in which group.
  CREATE TABLE person_chats (
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    chat_id   TEXT    NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    PRIMARY KEY (person_id, chat_id)
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- One row per message the app has set out to send. key is also the
  -- bridge's idempotency_key, and a 'sent' row is never sent again — this
  -- table is what stops a wish going out twice. No foreign keys: the history
  -- outlives a person or a group being removed.
  CREATE TABLE deliveries (
    key          TEXT    PRIMARY KEY,
    day          TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('wish', 'reminder', 'test')),
    person_id    INTEGER,
    person_name  TEXT,
    chat_id      TEXT    NOT NULL,
    chat_subject TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    message_id   TEXT,
    error        TEXT,
    created_at   TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at   TEXT    NOT NULL DEFAULT (${NOW})
  );
  CREATE INDEX deliveries_by_day ON deliveries (day);
  CREATE INDEX deliveries_by_update ON deliveries (updated_at);
  `,

  // 2 — each person has one place their wish goes (a group, or their own
  // number) and a message of their own; there is no Groups page any more.
  `
  ALTER TABLE people ADD COLUMN phone   TEXT NOT NULL DEFAULT '';  -- digits, country code first
  ALTER TABLE people ADD COLUMN send_to TEXT NOT NULL DEFAULT '';  -- '' | 'direct' | a group id
  ALTER TABLE people ADD COLUMN message TEXT NOT NULL DEFAULT '';  -- '' = the default from Settings

  -- Keep the first group each person was wished in, and that group's message.
  UPDATE people SET
    send_to = COALESCE((SELECT c.id FROM person_chats pc JOIN chats c ON c.id = pc.chat_id
                        WHERE pc.person_id = people.id AND c.wishes = 1
                        ORDER BY c.subject COLLATE NOCASE, c.id LIMIT 1), ''),
    message = COALESCE((SELECT c.template FROM person_chats pc JOIN chats c ON c.id = pc.chat_id
                        WHERE pc.person_id = people.id AND c.wishes = 1
                        ORDER BY c.subject COLLATE NOCASE, c.id LIMIT 1), '');

  -- The reminder goes to one place too, chosen on the Settings page.
  INSERT OR IGNORE INTO settings (key, value)
    SELECT 'reminder_to', id FROM chats WHERE reminders = 1 ORDER BY subject COLLATE NOCASE, id LIMIT 1;

  DROP TABLE person_chats;
  -- chats is now only the groups' names, for when WhatsApp is not connected.
  ALTER TABLE chats DROP COLUMN wishes;
  ALTER TABLE chats DROP COLUMN reminders;
  ALTER TABLE chats DROP COLUMN template;
  `,

  // 3 — each person's wish can go at a time of its own.
  `
  ALTER TABLE people ADD COLUMN send_time TEXT NOT NULL DEFAULT '';  -- 'HH:MM', or '' for the wish time in Settings
  `,

  // 4 — a row is a birthday or an anniversary (a couple's wedding day); the
  // day, month and year are that occasion's. Everything so far is a birthday.
  `
  ALTER TABLE people ADD COLUMN kind TEXT NOT NULL DEFAULT 'birthday' CHECK (kind IN ('birthday', 'anniversary'));
  `,

  // 5 — alerts: when a wish is not sent, the app tells you on WhatsApp. An
  // alert is a delivery like the others, but its text is kept (a wish's is
  // written from the plan each time), and it waits `pending` until WhatsApp
  // is connected. alerted_at marks a message an alert has told about, so
  // none is told twice. SQLite cannot change a CHECK: hence the new table.
  `
  CREATE TABLE deliveries_5 (
    key          TEXT    PRIMARY KEY,
    day          TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('wish', 'reminder', 'test', 'alert')),
    person_id    INTEGER,
    person_name  TEXT,
    chat_id      TEXT    NOT NULL,
    chat_subject TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    message_id   TEXT,
    error        TEXT,
    created_at   TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at   TEXT    NOT NULL DEFAULT (${NOW}),
    text         TEXT,
    alerted_at   TEXT
  );
  INSERT INTO deliveries_5 (key, day, kind, person_id, person_name, chat_id, chat_subject, status, attempts, message_id, error, created_at, updated_at)
    SELECT key, day, kind, person_id, person_name, chat_id, chat_subject, status, attempts, message_id, error, created_at, updated_at FROM deliveries;
  DROP TABLE deliveries;
  ALTER TABLE deliveries_5 RENAME TO deliveries;
  CREATE INDEX deliveries_by_day ON deliveries (day);
  CREATE INDEX deliveries_by_update ON deliveries (updated_at);
  `,

  // 6 — the notebook. A note, or a journal page: one per day, `day` is
  // 'YYYY-MM-DD'. A note can be about someone on the list; when they are
  // deleted, the note stays. tags are the #words in the text (notes.mjs,
  // tagsOf), lowercase and space-separated. notes_fts is the search index,
  // kept in step by the triggers below.
  `
  CREATE TABLE notes (
    id         INTEGER PRIMARY KEY,
    kind       TEXT    NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'journal')),
    day        TEXT    CHECK (day IS NULL OR day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    title      TEXT    NOT NULL DEFAULT '',
    body       TEXT    NOT NULL DEFAULT '',
    tags       TEXT    NOT NULL DEFAULT '',
    pinned     INTEGER NOT NULL DEFAULT 0,
    person_id  INTEGER REFERENCES people(id) ON DELETE SET NULL,
    created_at TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW}),
    CHECK ((kind = 'journal') = (day IS NOT NULL))
  );
  CREATE UNIQUE INDEX notes_journal_day ON notes (day) WHERE kind = 'journal';
  CREATE INDEX notes_by_person ON notes (person_id) WHERE person_id IS NOT NULL;

  CREATE VIRTUAL TABLE notes_fts USING fts5(
    title, body, content = 'notes', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
  CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts (notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  END;
  CREATE TRIGGER notes_fts_update AFTER UPDATE OF title, body ON notes BEGIN
    INSERT INTO notes_fts (notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    INSERT INTO notes_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
  `,

  // 7 — the calendar: events and tasks. Days are 'YYYY-MM-DD', times
  // 'HH:MM' ('' for an event all day long). An event can last several days
  // (end_day), repeat (calendar.mjs, startsBetween) and have one reminder,
  // `remind` minutes before it starts. And two more kinds of message: an
  // event's reminder, and "Your day" each morning — both to where Settings
  // says calendar messages go. title is what a message was about, for the
  // page: an event's title.
  `
  CREATE TABLE events (
    id           INTEGER PRIMARY KEY,
    title        TEXT    NOT NULL,
    day          TEXT    NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    end_day      TEXT    CHECK (end_day IS NULL OR (end_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND end_day > day)),
    time         TEXT    NOT NULL DEFAULT '',
    end_time     TEXT    NOT NULL DEFAULT '',
    repeat       TEXT    NOT NULL DEFAULT '' CHECK (repeat IN ('', 'daily', 'weekly', 'monthly', 'yearly')),
    repeat_until TEXT    CHECK (repeat_until IS NULL OR repeat_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    remind       INTEGER CHECK (remind IS NULL OR remind >= 0),
    notes        TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at   TEXT    NOT NULL DEFAULT (${NOW})
  );
  CREATE INDEX events_by_day ON events (day);

  CREATE TABLE tasks (
    id         INTEGER PRIMARY KEY,
    title      TEXT    NOT NULL,
    due        TEXT    CHECK (due IS NULL OR due GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    notes      TEXT    NOT NULL DEFAULT '',
    done_at    TEXT,
    created_at TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW})
  );

  CREATE TABLE deliveries_7 (
    key          TEXT    PRIMARY KEY,
    day          TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('wish', 'reminder', 'test', 'alert', 'event', 'agenda')),
    person_id    INTEGER,
    person_name  TEXT,
    chat_id      TEXT    NOT NULL,
    chat_subject TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    message_id   TEXT,
    error        TEXT,
    created_at   TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at   TEXT    NOT NULL DEFAULT (${NOW}),
    text         TEXT,
    alerted_at   TEXT,
    title        TEXT
  );
  INSERT INTO deliveries_7 (key, day, kind, person_id, person_name, chat_id, chat_subject, status, attempts, message_id, error, created_at, updated_at, text, alerted_at)
    SELECT key, day, kind, person_id, person_name, chat_id, chat_subject, status, attempts, message_id, error, created_at, updated_at, text, alerted_at FROM deliveries;
  DROP TABLE deliveries;
  ALTER TABLE deliveries_7 RENAME TO deliveries;
  CREATE INDEX deliveries_by_day ON deliveries (day);
  CREATE INDEX deliveries_by_update ON deliveries (updated_at);
  `,

  // 8 — 📅 messages: what you send on WhatsApp to put on the calendar
  // (capture.mjs). One row each, keyed by WhatsApp's message id, so none is
  // added twice; and what it became — an event or a task, or nothing while
  // that is switched off (kind NULL). Their answer, in Message yourself, is
  // a message too: kind 'capture'.
  `
  CREATE TABLE captures (
    message_id TEXT    PRIMARY KEY,
    chat_id    TEXT    NOT NULL,
    sent_at    TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    quoted     TEXT,
    kind       TEXT    CHECK (kind IS NULL OR kind IN ('event', 'task')),
    item_id    INTEGER,
    created_at TEXT    NOT NULL DEFAULT (${NOW})
  );

  CREATE TABLE deliveries_8 (
    key          TEXT    PRIMARY KEY,
    day          TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('wish', 'reminder', 'test', 'alert', 'event', 'agenda', 'capture')),
    person_id    INTEGER,
    person_name  TEXT,
    chat_id      TEXT    NOT NULL,
    chat_subject TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    message_id   TEXT,
    error        TEXT,
    created_at   TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at   TEXT    NOT NULL DEFAULT (${NOW}),
    text         TEXT,
    alerted_at   TEXT,
    title        TEXT
  );
  INSERT INTO deliveries_8 SELECT key, day, kind, person_id, person_name, chat_id, chat_subject, status, attempts, message_id, error, created_at, updated_at, text, alerted_at, title FROM deliveries;
  DROP TABLE deliveries;
  ALTER TABLE deliveries_8 RENAME TO deliveries;
  CREATE INDEX deliveries_by_day ON deliveries (day);
  CREATE INDEX deliveries_by_update ON deliveries (updated_at);
  `,
];

function migrate(db) {
  const { user_version: version } = db.prepare("PRAGMA user_version").get();
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

const person = (r) =>
  r
    ? {
        id: r.id,
        name: r.name,
        day: r.day,
        month: r.month,
        year: r.year,
        notes: r.notes,
        active: r.active === 1,
        phone: r.phone,
        sendTo: r.send_to,
        message: r.message,
        sendTime: r.send_time,
        kind: r.kind,
        createdAt: r.created_at,
      }
    : null;
const delivery = (r) => (r ? { ...r } : null);
const event = (r) =>
  r
    ? {
        id: r.id,
        title: r.title,
        day: r.day,
        endDay: r.end_day,
        time: r.time,
        endTime: r.end_time,
        repeat: r.repeat,
        repeatUntil: r.repeat_until,
        remind: r.remind,
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }
    : null;
const task = (r) =>
  r
    ? { id: r.id, title: r.title, due: r.due, notes: r.notes, done: r.done_at !== null, doneAt: r.done_at, createdAt: r.created_at, updatedAt: r.updated_at }
    : null;
/* A note or a journal page. body is the whole text, from get(); a list has
 * the start of it as preview, and a search the matching part as snippet
 * (the words found between \u0001 and \u0002). */
const note = (r) =>
  r
    ? {
        id: r.id,
        kind: r.kind,
        day: r.day,
        title: r.title,
        body: r.body,
        preview: r.preview,
        snippet: r.snippet,
        tags: r.tags ? r.tags.split(" ") : [],
        pinned: r.pinned === 1,
        person: r.person_id ? { id: r.person_id, name: r.person_name, kind: r.person_kind } : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }
    : null;

export function openDb(file, { defaultTimezone = "Asia/Kolkata" } = {}) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);

  const q = (sql) => db.prepare(sql);
  /* Re-entrant: an import creates many people in one transaction, and each
   * create is a transaction of its own when called alone. */
  let depth = 0;
  function transaction(fn) {
    if (depth > 0) return fn();
    db.exec("BEGIN IMMEDIATE");
    depth++;
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    } finally {
      depth--;
    }
  }

  const PERSON_FIELDS = "name = ?, day = ?, month = ?, year = ?, notes = ?, active = ?, phone = ?, send_to = ?, message = ?, send_time = ?, kind = ?";
  const personValues = ({ name, day, month, year = null, notes = "", active = true, phone = "", sendTo = "", message = "", sendTime = "", kind = "birthday" }) => [
    name,
    day,
    month,
    year,
    notes,
    active ? 1 : 0,
    phone,
    sendTo,
    message,
    sendTime,
    kind,
  ];

  const people = {
    all: () => q("SELECT * FROM people ORDER BY name COLLATE NOCASE, id").all().map(person),
    active: () => q("SELECT * FROM people WHERE active = 1 ORDER BY name COLLATE NOCASE, id").all().map(person),
    get: (id) => person(q("SELECT * FROM people WHERE id = ?").get(id)),
    count: () => q("SELECT COUNT(*) AS n FROM people").get().n,
    /* The same occasion already on the list: same name, kind and date. */
    exists: (name, day, month, kind = "birthday") =>
      Boolean(q("SELECT 1 FROM people WHERE name = ? COLLATE NOCASE AND day = ? AND month = ? AND kind = ?").get(name, day, month, kind)),
    /* createdAt: when they were added — now, unless a test says otherwise. */
    create: (fields) =>
      Number(
        q(
          `INSERT INTO people (name, day, month, year, notes, active, phone, send_to, message, send_time, kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ${NOW}))`,
        ).run(...personValues(fields), fields.createdAt ?? null).lastInsertRowid,
      ),
    update: (id, fields) => q(`UPDATE people SET ${PERSON_FIELDS}, updated_at = ${NOW} WHERE id = ?`).run(...personValues(fields), id),
    /* The People table's Save: number, where the wish goes, when, and the
     * message, for many people at once. */
    updateMany: (rows) =>
      transaction(() => {
        const update = q(`UPDATE people SET phone = ?, send_to = ?, send_time = ?, message = ?, updated_at = ${NOW} WHERE id = ?`);
        let changed = 0;
        for (const r of rows) changed += Number(update.run(r.phone, r.sendTo, r.sendTime ?? "", r.message, r.id).changes);
        return changed;
      }),
    remove: (id) => q("DELETE FROM people WHERE id = ?").run(id).changes > 0,
  };

  /* The groups the linked number is in, as WhatsApp last listed them — so a
   * group's name still shows while WhatsApp is not connected. */
  const chats = {
    all: () => q("SELECT id, subject FROM chats ORDER BY subject COLLATE NOCASE, id").all().map((r) => ({ id: r.id, subject: r.subject })),
    names: () => new Map(q("SELECT id, subject FROM chats").all().map((r) => [r.id, r.subject])),
    remember: (groups) =>
      transaction(() => {
        const upsert = q("INSERT INTO chats (id, subject) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET subject = excluded.subject");
        for (const g of groups) upsert.run(g.id, g.subject || "Unnamed group");
      }),
  };

  const defaults = {
    enabled: "0",
    wish_time: "08:00",
    reminder_time: "06:00",
    timezone: defaultTimezone,
    days_ahead: "1",
    template: DEFAULT_TEMPLATE,
    anniversary_template: DEFAULT_ANNIVERSARY_TEMPLATE,
    reminder_to: "",
    alert_to: "self",
    calendar_to: "self",
    capture: "1",
    my_phone: "",
    country_code: "91",
  };

  const settings = {
    get() {
      const values = { ...defaults };
      for (const { key, value } of q("SELECT key, value FROM settings").all()) values[key] = value;
      return {
        enabled: values.enabled === "1",
        wishTime: values.wish_time,
        reminderTime: values.reminder_time,
        timezone: values.timezone,
        daysAhead: Number(values.days_ahead),
        template: values.template,
        anniversaryTemplate: values.anniversary_template,
        reminderTo: values.reminder_to, // '' (no reminder) | 'self' (the linked phone) | 'direct' (my number) | a group id
        alertTo: values.alert_to, // the same choices; '' is no alerts
        calendarTo: values.calendar_to, // the same again: where "Your day" and event reminders go
        capture: values.capture === "1", // 📅 messages you send on WhatsApp go on the calendar
        myPhone: values.my_phone,
        countryCode: values.country_code,
      };
    },
    save({ enabled, wishTime, reminderTime, timezone, daysAhead, template, anniversaryTemplate, reminderTo, alertTo, calendarTo, capture, myPhone, countryCode }) {
      const upsert = q("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
      const values = {
        enabled: enabled === undefined ? undefined : enabled ? "1" : "0",
        wish_time: wishTime,
        reminder_time: reminderTime,
        timezone,
        days_ahead: daysAhead === undefined ? undefined : String(daysAhead),
        template,
        anniversary_template: anniversaryTemplate,
        reminder_to: reminderTo,
        alert_to: alertTo,
        calendar_to: calendarTo,
        capture: capture === undefined ? undefined : capture ? "1" : "0",
        my_phone: myPhone,
        country_code: countryCode,
      };
      transaction(() => {
        for (const [key, value] of Object.entries(values)) if (value !== undefined) upsert.run(key, value);
      });
    },
  };

  /* The password set on the Settings page, as a salted scrypt hash (auth.mjs
   * makes and checks it) — or null while the one in .env applies.
   * scripts/reset-password.sh deletes it. */
  const password = {
    hash: () => q("SELECT value FROM settings WHERE key = 'password_hash'").get()?.value ?? null,
    set: (hash) =>
      q("INSERT INTO settings (key, value) VALUES ('password_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(hash),
    clear: () => q("DELETE FROM settings WHERE key = 'password_hash'").run(),
  };

  /* Times here come from the scheduler's clock (`at`, an ISO string), not
   * SQLite's: the retry rules compare them with that clock. */
  const deliveries = {
    get: (key) => delivery(q("SELECT * FROM deliveries WHERE key = ?").get(key)),
    /* About to call the bridge: one more attempt, marked `sending` until the
     * answer is in. A row left `sending` means the app stopped mid-send. */
    /* chat_id / chat_subject: where it went — a group, or a number — and
     * how the page names it. text is kept for an alert only (a new row);
     * title, for a calendar message: what it was about. */
    begin: ({ key, day, kind, person: p = null, to, title = null }, at, text = null) =>
      q(
        `INSERT INTO deliveries (key, day, kind, person_id, person_name, chat_id, chat_subject, status, attempts, text, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET status = 'sending', attempts = attempts + 1, error = NULL, chat_id = excluded.chat_id,
           chat_subject = excluded.chat_subject, person_name = excluded.person_name, title = excluded.title, updated_at = excluded.updated_at`,
      ).run(key, day, kind, p?.id ?? null, p?.name ?? null, to.id, to.label, text, title, at, at),
    succeed: (key, messageId, at) =>
      q("UPDATE deliveries SET status = 'sent', message_id = ?, error = NULL, updated_at = ? WHERE key = ?").run(
        messageId,
        at,
        key,
      ),
    fail: (key, error, at) =>
      q("UPDATE deliveries SET status = 'failed', error = ?, updated_at = ? WHERE key = ?").run(error, at, key),
    recent: (limit = 20) =>
      q("SELECT * FROM deliveries ORDER BY updated_at DESC, key LIMIT ?").all(limit).map(delivery),
    /* History is kept for a year; older rows go. */
    prune: (beforeDay) => q("DELETE FROM deliveries WHERE day < ?").run(beforeDay).changes,
  };

  /* Alerts: messages to you about wishes that were not sent. Each is a
   * delivery of kind 'alert' that waits, `pending`, until it can go; where
   * it goes is decided then, from Settings. */
  const CHECKED_THROUGH = "alerts_checked_through";
  const alerts = {
    /* A new alert, and the messages it tells about marked as told — both or
     * neither. A key already used is left as it is. */
    create: ({ key, day, text, about = [] }, at) =>
      transaction(() => {
        q(
          `INSERT OR IGNORE INTO deliveries (key, day, kind, chat_id, status, attempts, text, created_at, updated_at)
           VALUES (?, ?, 'alert', '', 'pending', 0, ?, ?, ?)`,
        ).run(key, day, text, at, at);
        const told = q("UPDATE deliveries SET alerted_at = ? WHERE key = ?");
        for (const k of about) told.run(at, k);
      }),
    /* The alerts not sent yet that were made at `since` or later, oldest
     * first. */
    unsent: (since) =>
      q("SELECT * FROM deliveries WHERE kind = 'alert' AND status <> 'sent' AND created_at >= ? ORDER BY created_at, key")
        .all(since)
        .map(delivery),
    /* Alerts still waiting that were made before `before` will not go: said
     * so on the page, instead of waiting there for good. */
    expire: (before, at) =>
      q("UPDATE deliveries SET status = 'failed', error = ?, updated_at = ? WHERE kind = 'alert' AND status = 'pending' AND created_at < ?").run(
        "Dropped: it could not go out within 3 days.",
        at,
        before,
      ).changes,
    /* The last day already looked over for wishes that were not sent (a
     * 'YYYY-MM-DD'), or null before the first look. */
    checkedThrough: () => q("SELECT value FROM settings WHERE key = ?").get(CHECKED_THROUGH)?.value ?? null,
    setCheckedThrough: (day) =>
      q("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(CHECKED_THROUGH, day),
  };

  /* The notebook: notes, and the journal's pages (one a day). */
  const NOTE = `n.id, n.kind, n.day, n.title, n.tags, n.pinned, n.person_id, n.created_at, n.updated_at,
    p.name AS person_name, p.kind AS person_kind`;
  const NOTES = "notes n LEFT JOIN people p ON p.id = n.person_id";
  const NEWEST = "n.pinned DESC, n.updated_at DESC, n.id DESC";
  const tagsFor = (...texts) => tagsOf(texts.join("\n")).join(" ");

  const notes = {
    get: (id) => note(q(`SELECT ${NOTE}, n.body FROM ${NOTES} WHERE n.id = ? AND n.kind = 'note'`).get(id)),
    /* Pinned first, then the latest edited. Notes only — with a tag, the
     * journal pages that have it too. */
    list: ({ tag = null, limit = 200 } = {}) =>
      (tag
        ? q(`SELECT ${NOTE}, substr(n.body, 1, 400) AS preview FROM ${NOTES} WHERE instr(' ' || n.tags || ' ', ?) > 0 ORDER BY ${NEWEST} LIMIT ?`).all(` ${tag} `, limit)
        : q(`SELECT ${NOTE}, substr(n.body, 1, 400) AS preview FROM ${NOTES} WHERE n.kind = 'note' ORDER BY ${NEWEST} LIMIT ?`).all(limit)
      ).map(note),
    count: () => q("SELECT COUNT(*) AS n FROM notes WHERE kind = 'note'").get().n,
    forPerson: (personId) =>
      q(`SELECT ${NOTE}, substr(n.body, 1, 400) AS preview FROM ${NOTES} WHERE n.person_id = ? AND n.kind = 'note' ORDER BY ${NEWEST}`)
        .all(personId)
        .map(note),
    /* Notes and journal pages with every word of `query` — an FTS5 query
     * from notes.mjs (searchQuery), never what was typed — best match first,
     * a title counting for more than the text. */
    search: (query, limit = 50) =>
      query
        ? q(
            `SELECT ${NOTE}, substr(n.body, 1, 400) AS preview, snippet(notes_fts, -1, char(1), char(2), '…', 24) AS snippet
             FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid LEFT JOIN people p ON p.id = n.person_id
             WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts, 4.0, 1.0), n.updated_at DESC LIMIT ?`,
          )
            .all(query, limit)
            .map(note)
        : [],
    /* Every tag in use, most used first. */
    tags() {
      const counts = new Map();
      for (const { tags } of q("SELECT tags FROM notes WHERE tags <> ''").all()) {
        for (const tag of tags.split(" ")) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    },
    create: ({ title = "", body = "", pinned = false, personId = null }) =>
      Number(
        q("INSERT INTO notes (title, body, tags, pinned, person_id) VALUES (?, ?, ?, ?, ?)").run(title, body, tagsFor(title, body), pinned ? 1 : 0, personId)
          .lastInsertRowid,
      ),
    update: (id, { title = "", body = "", pinned = false, personId = null }) =>
      q(`UPDATE notes SET title = ?, body = ?, tags = ?, pinned = ?, person_id = ?, updated_at = ${NOW} WHERE id = ? AND kind = 'note'`).run(
        title,
        body,
        tagsFor(title, body),
        pinned ? 1 : 0,
        personId,
        id,
      ).changes > 0,
    /* Pinning is not an edit: the note keeps its place among the others. */
    setPinned: (id, pinned) => q("UPDATE notes SET pinned = ? WHERE id = ? AND kind = 'note'").run(pinned ? 1 : 0, id).changes > 0,
    remove: (id) => q("DELETE FROM notes WHERE id = ? AND kind = 'note'").run(id).changes > 0,
  };

  const journal = {
    get: (day) => note(q(`SELECT ${NOTE}, n.body FROM ${NOTES} WHERE n.kind = 'journal' AND n.day = ?`).get(day)),
    /* Writes the day's page. A page saved empty is no page. */
    save: (day, body) =>
      body.trim()
        ? q(
            `INSERT INTO notes (kind, day, body, tags) VALUES ('journal', ?, ?, ?)
             ON CONFLICT (day) WHERE kind = 'journal' DO UPDATE SET body = excluded.body, tags = excluded.tags, updated_at = ${NOW}`,
          ).run(day, body, tagsFor(body))
        : q("DELETE FROM notes WHERE kind = 'journal' AND day = ?").run(day),
    /* The latest pages, by their day. */
    recent: (limit = 14) =>
      q(`SELECT ${NOTE}, substr(n.body, 1, 160) AS preview FROM ${NOTES} WHERE n.kind = 'journal' ORDER BY n.day DESC LIMIT ?`)
        .all(limit)
        .map(note),
    count: () => q("SELECT COUNT(*) AS n FROM notes WHERE kind = 'journal'").get().n,
    /* The days from `from` through `to` that have a page. */
    daysBetween: (from, to) => q("SELECT day FROM notes WHERE kind = 'journal' AND day BETWEEN ? AND ? ORDER BY day").all(from, to).map((r) => r.day),
  };

  /* The calendar. Which days an event falls on is calendar.mjs's to say;
   * these only keep them. */
  const EVENT_FIELDS = "title = ?, day = ?, end_day = ?, time = ?, end_time = ?, repeat = ?, repeat_until = ?, remind = ?, notes = ?";
  const eventValues = ({ title, day, endDay = null, time = "", endTime = "", repeat = "", repeatUntil = null, remind = null, notes = "" }) => [
    title,
    day,
    endDay,
    time,
    endTime,
    repeat,
    repeat ? repeatUntil : null,
    remind,
    notes,
  ];

  const events = {
    get: (id) => event(q("SELECT * FROM events WHERE id = ?").get(id)),
    /* Every event that may fall on a day from `from` through `to`: one that
     * starts by `to`, and repeats or lasts until `from` at least. */
    between: (from, to) =>
      q("SELECT * FROM events WHERE day <= ? AND (repeat <> '' OR COALESCE(end_day, day) >= ?) ORDER BY day, time, id").all(to, from).map(event),
    count: () => q("SELECT COUNT(*) AS n FROM events").get().n,
    create: (fields) =>
      Number(
        q("INSERT INTO events (title, day, end_day, time, end_time, repeat, repeat_until, remind, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          ...eventValues(fields),
        ).lastInsertRowid,
      ),
    update: (id, fields) => q(`UPDATE events SET ${EVENT_FIELDS}, updated_at = ${NOW} WHERE id = ?`).run(...eventValues(fields), id).changes > 0,
    remove: (id) => q("DELETE FROM events WHERE id = ?").run(id).changes > 0,
  };

  const tasks = {
    get: (id) => task(q("SELECT * FROM tasks WHERE id = ?").get(id)),
    /* Not done yet: those with a due day first, soonest first; then the
     * ones with none, oldest first. */
    open: () => q("SELECT * FROM tasks WHERE done_at IS NULL ORDER BY due IS NULL, due, id").all().map(task),
    /* Not done, and due on `day` or before it. */
    dueBy: (day) => q("SELECT * FROM tasks WHERE done_at IS NULL AND due <= ? ORDER BY due, id").all(day).map(task),
    /* Due from `from` through `to`, done or not — for the month. */
    dueBetween: (from, to) => q("SELECT * FROM tasks WHERE due BETWEEN ? AND ? ORDER BY due, done_at IS NOT NULL, id").all(from, to).map(task),
    /* The latest done. */
    done: (limit = 10) => q("SELECT * FROM tasks WHERE done_at IS NOT NULL ORDER BY done_at DESC, id DESC LIMIT ?").all(limit).map(task),
    create: ({ title, due = null, notes = "" }) => Number(q("INSERT INTO tasks (title, due, notes) VALUES (?, ?, ?)").run(title, due, notes).lastInsertRowid),
    update: (id, { title, due = null, notes = "" }) =>
      q(`UPDATE tasks SET title = ?, due = ?, notes = ?, updated_at = ${NOW} WHERE id = ?`).run(title, due, notes, id).changes > 0,
    setDone: (id, done) =>
      q(`UPDATE tasks SET done_at = ${done ? `COALESCE(done_at, ${NOW})` : "NULL"} WHERE id = ?`).run(id).changes > 0,
    remove: (id) => q("DELETE FROM tasks WHERE id = ?").run(id).changes > 0,
  };

  /* 📅 messages taken from the bridge: each once. */
  const captures = {
    has: (messageId) => Boolean(q("SELECT 1 FROM captures WHERE message_id = ?").get(messageId)),
    record: ({ id, chat_id: chatId, sent_at: sentAt, text, quoted }, kind = null, itemId = null) =>
      q("INSERT OR IGNORE INTO captures (message_id, chat_id, sent_at, text, quoted, kind, item_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id,
        chatId,
        sentAt,
        text,
        quoted,
        kind,
        itemId,
      ).changes > 0,
    /* Kept a month: long after the bridge has let the message go. */
    prune: (before) => q("DELETE FROM captures WHERE created_at < ?").run(before).changes,
  };

  return { people, chats, settings, password, deliveries, alerts, notes, journal, events, tasks, captures, transaction, close: () => db.close() };
}
