/* Everything the app remembers, in one SQLite file (node:sqlite, built into
 * Node 24 — no native module to build). In Docker that file is
 * /data/birthdays.db in the app_data volume.
 *
 * The schema moves forward through MIGRATIONS, counted in PRAGMA
 * user_version. Append to the list; never edit an entry that has shipped. */

import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ANNIVERSARY_TEMPLATE, DEFAULT_TEMPLATE } from "./messages.mjs";

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
      }
    : null;
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
    create: (fields) =>
      Number(
        q(
          "INSERT INTO people (name, day, month, year, notes, active, phone, send_to, message, send_time, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(...personValues(fields)).lastInsertRowid,
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
        myPhone: values.my_phone,
        countryCode: values.country_code,
      };
    },
    save({ enabled, wishTime, reminderTime, timezone, daysAhead, template, anniversaryTemplate, reminderTo, myPhone, countryCode }) {
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
     * how the page names it. */
    begin: ({ key, day, kind, person: p = null, to }, at) =>
      q(
        `INSERT INTO deliveries (key, day, kind, person_id, person_name, chat_id, chat_subject, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?)
         ON CONFLICT (key) DO UPDATE SET status = 'sending', attempts = attempts + 1, error = NULL, chat_id = excluded.chat_id,
           chat_subject = excluded.chat_subject, person_name = excluded.person_name, updated_at = excluded.updated_at`,
      ).run(key, day, kind, p?.id ?? null, p?.name ?? null, to.id, to.label, at, at),
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

  return { people, chats, settings, password, deliveries, transaction, close: () => db.close() };
}
