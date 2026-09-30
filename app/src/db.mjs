/* Everything the app remembers, in one SQLite file (node:sqlite, built into
 * Node 24 — no native module to build). In Docker that file is
 * /data/birthdays.db in the app_data volume.
 *
 * The schema moves forward through MIGRATIONS, counted in PRAGMA
 * user_version. Append to the list; never edit an entry that has shipped. */

import { DatabaseSync } from "node:sqlite";
import { DEFAULT_TEMPLATE } from "./messages.mjs";

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
  r ? { id: r.id, name: r.name, day: r.day, month: r.month, year: r.year, notes: r.notes, active: r.active === 1 } : null;
const chat = (r) =>
  r ? { id: r.id, subject: r.subject, wishes: r.wishes === 1, reminders: r.reminders === 1, template: r.template } : null;
const delivery = (r) => (r ? { ...r } : null);

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

  /* Only groups that exist: an id from a stale form is dropped, not an error. */
  function setChats(personId, chatIds) {
    q("DELETE FROM person_chats WHERE person_id = ?").run(personId);
    const insert = q("INSERT OR IGNORE INTO person_chats (person_id, chat_id) SELECT ?, id FROM chats WHERE id = ?");
    for (const chatId of new Set(chatIds)) insert.run(personId, chatId);
  }

  const people = {
    all: () => q("SELECT * FROM people ORDER BY name COLLATE NOCASE, id").all().map(person),
    active: () => q("SELECT * FROM people WHERE active = 1 ORDER BY name COLLATE NOCASE, id").all().map(person),
    get: (id) => person(q("SELECT * FROM people WHERE id = ?").get(id)),
    count: () => q("SELECT COUNT(*) AS n FROM people").get().n,
    exists: (name, day, month) =>
      Boolean(q("SELECT 1 FROM people WHERE name = ? COLLATE NOCASE AND day = ? AND month = ?").get(name, day, month)),
    create: ({ name, day, month, year = null, notes = "", active = true, chatIds = [] }) =>
      transaction(() => {
        const { lastInsertRowid } = q(
          "INSERT INTO people (name, day, month, year, notes, active) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(name, day, month, year, notes, active ? 1 : 0);
        const id = Number(lastInsertRowid);
        setChats(id, chatIds);
        return id;
      }),
    update: (id, { name, day, month, year = null, notes = "", active = true, chatIds = [] }) =>
      transaction(() => {
        q(
          `UPDATE people SET name = ?, day = ?, month = ?, year = ?, notes = ?, active = ?, updated_at = ${NOW} WHERE id = ?`,
        ).run(name, day, month, year, notes, active ? 1 : 0, id);
        setChats(id, chatIds);
      }),
    remove: (id) => q("DELETE FROM people WHERE id = ?").run(id).changes > 0,
    chatIds: (id) => q("SELECT chat_id FROM person_chats WHERE person_id = ?").all(id).map((r) => r.chat_id),
    /* person id → Set of the group ids they are wished in. */
    assignments() {
      const map = new Map();
      for (const { person_id: p, chat_id: c } of q("SELECT person_id, chat_id FROM person_chats").all()) {
        if (!map.has(p)) map.set(p, new Set());
        map.get(p).add(c);
      }
      return map;
    },
  };

  const chats = {
    all: () => q("SELECT * FROM chats ORDER BY subject COLLATE NOCASE, id").all().map(chat),
    get: (id) => chat(q("SELECT * FROM chats WHERE id = ?").get(id)),
    add: ({ id, subject, wishes = true, reminders = false }) =>
      q("INSERT OR IGNORE INTO chats (id, subject, wishes, reminders) VALUES (?, ?, ?, ?)").run(
        id,
        subject,
        wishes ? 1 : 0,
        reminders ? 1 : 0,
      ).changes > 0,
    update: (id, { wishes, reminders, template }) =>
      q("UPDATE chats SET wishes = ?, reminders = ?, template = ? WHERE id = ?").run(
        wishes ? 1 : 0,
        reminders ? 1 : 0,
        template,
        id,
      ),
    rename: (id, subject) => q("UPDATE chats SET subject = ? WHERE id = ? AND subject <> ?").run(subject, id, subject),
    remove: (id) => q("DELETE FROM chats WHERE id = ?").run(id).changes > 0,
    /* Wish everyone on the list in this group; returns how many were added. */
    addEveryone: (id) =>
      Number(q("INSERT OR IGNORE INTO person_chats (person_id, chat_id) SELECT id, ? FROM people").run(id).changes),
    /* group id → how many people are wished there. */
    memberCounts: () =>
      new Map(q("SELECT chat_id, COUNT(*) AS n FROM person_chats GROUP BY chat_id").all().map((r) => [r.chat_id, r.n])),
  };

  const defaults = {
    enabled: "0",
    wish_time: "08:00",
    reminder_time: "07:00",
    timezone: defaultTimezone,
    days_ahead: "1",
    template: DEFAULT_TEMPLATE,
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
      };
    },
    save({ enabled, wishTime, reminderTime, timezone, daysAhead, template }) {
      const upsert = q("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
      const values = {
        enabled: enabled === undefined ? undefined : enabled ? "1" : "0",
        wish_time: wishTime,
        reminder_time: reminderTime,
        timezone,
        days_ahead: daysAhead === undefined ? undefined : String(daysAhead),
        template,
      };
      transaction(() => {
        for (const [key, value] of Object.entries(values)) if (value !== undefined) upsert.run(key, value);
      });
    },
  };

  /* Times here come from the scheduler's clock (`at`, an ISO string), not
   * SQLite's: the retry rules compare them with that clock. */
  const deliveries = {
    get: (key) => delivery(q("SELECT * FROM deliveries WHERE key = ?").get(key)),
    /* About to call the bridge: one more attempt, marked `sending` until the
     * answer is in. A row left `sending` means the app stopped mid-send. */
    begin: ({ key, day, kind, person: p = null, chat: c }, at) =>
      q(
        `INSERT INTO deliveries (key, day, kind, person_id, person_name, chat_id, chat_subject, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?)
         ON CONFLICT (key) DO UPDATE SET status = 'sending', attempts = attempts + 1, error = NULL,
           chat_subject = excluded.chat_subject, person_name = excluded.person_name, updated_at = excluded.updated_at`,
      ).run(key, day, kind, p?.id ?? null, p?.name ?? null, c.id, c.subject, at, at),
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

  return { people, chats, settings, deliveries, transaction, close: () => db.close() };
}
