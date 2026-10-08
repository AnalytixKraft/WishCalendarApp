import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDb } from "../src/db.mjs";

/* A database as the first version left it: people wished in groups, a
 * group marked for the reminder, a group with its own message. */
function firstVersionDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, day INTEGER NOT NULL, month INTEGER NOT NULL, year INTEGER,
      notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE chats (id TEXT PRIMARY KEY, subject TEXT NOT NULL, wishes INTEGER NOT NULL DEFAULT 1, reminders INTEGER NOT NULL DEFAULT 0,
      template TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE person_chats (person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, PRIMARY KEY (person_id, chat_id));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE deliveries (key TEXT PRIMARY KEY, day TEXT NOT NULL, kind TEXT NOT NULL, person_id INTEGER, person_name TEXT,
      chat_id TEXT NOT NULL, chat_subject TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      message_id TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
    INSERT INTO people (id, name, day, month) VALUES (1, 'Anu', 30, 9), (2, 'Biju', 1, 10), (3, 'Cara', 2, 10);
    INSERT INTO chats (id, subject, wishes, reminders, template) VALUES
      ('1@g.us', 'Youth', 1, 0, 'Happy birthday from the youth, {first_name}!'),
      ('2@g.us', 'Choir', 1, 0, ''),
      ('3@g.us', 'Me', 0, 1, '');
    INSERT INTO person_chats VALUES (1, '2@g.us'), (1, '1@g.us'), (2, '2@g.us');
    PRAGMA user_version = 1;
  `);
  db.close();
}

test("the first version's database moves to one destination and one message per person", () => {
  const dir = mkdtempSync(join(tmpdir(), "bdr-"));
  try {
    const file = join(dir, "birthdays.db");
    firstVersionDb(file);
    const db = openDb(file);
    const [anu, biju, cara] = [1, 2, 3].map((id) => db.people.get(id));
    // Anu was in Choir and Youth: the first by name wins, with its message.
    assert.equal(anu.sendTo, "2@g.us");
    assert.equal(anu.message, "");
    assert.equal(biju.sendTo, "2@g.us");
    assert.equal(cara.sendTo, "");
    assert.equal(db.settings.get().reminderTo, "3@g.us");
    assert.deepEqual(db.chats.all().map((c) => c.subject), ["Choir", "Me", "Youth"]);
    assert.equal(anu.sendTime, "", "migration 3: everyone starts on the time in Settings");
    assert.equal(anu.kind, "birthday", "migration 4: everything so far is a birthday");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a group's own message moves to the people wished there", () => {
  const dir = mkdtempSync(join(tmpdir(), "bdr-"));
  try {
    const file = join(dir, "birthdays.db");
    firstVersionDb(file);
    const raw = new DatabaseSync(file);
    raw.exec("DELETE FROM person_chats WHERE person_id = 1 AND chat_id = '2@g.us'");
    raw.close();
    const db = openDb(file);
    assert.equal(db.people.get(1).sendTo, "1@g.us");
    assert.equal(db.people.get(1).message, "Happy birthday from the youth, {first_name}!");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same name and date can be a birthday and an anniversary, but not twice either", () => {
  const db = openDb(":memory:");
  db.people.create({ name: "Joseph & Mary", day: 15, month: 5 });
  assert.equal(db.people.exists("joseph & mary", 15, 5, "birthday"), true);
  assert.equal(db.people.exists("Joseph & Mary", 15, 5, "anniversary"), false);
  const id = db.people.create({ kind: "anniversary", name: "Joseph & Mary", day: 15, month: 5, year: 1995 });
  assert.equal(db.people.get(id).kind, "anniversary");
  assert.throws(() => db.people.create({ kind: "feast", name: "X", day: 1, month: 1 }), /CHECK constraint failed/);
});

test("updateMany saves the People table in one go", () => {
  const db = openDb(":memory:");
  const a = db.people.create({ name: "A", day: 1, month: 1 });
  const b = db.people.create({ name: "B", day: 2, month: 2 });
  const changed = db.people.updateMany([
    { id: a, phone: "447700900001", sendTo: "direct", sendTime: "09:30", message: "Hi A" },
    { id: b, phone: "", sendTo: "9@g.us", message: "" },
  ]);
  assert.equal(changed, 2);
  assert.deepEqual([db.people.get(a).sendTo, db.people.get(a).phone, db.people.get(a).sendTime, db.people.get(b).sendTo, db.people.get(b).sendTime], ["direct", "447700900001", "09:30", "9@g.us", ""]);
});

test("migration 5 keeps what was sent, and makes room for alerts", () => {
  const dir = mkdtempSync(join(tmpdir(), "bdr-"));
  try {
    const file = join(dir, "birthdays.db");
    firstVersionDb(file);
    const raw = new DatabaseSync(file);
    raw.exec(`INSERT INTO deliveries (key, day, kind, person_id, person_name, chat_id, chat_subject, status, attempts, message_id, created_at, updated_at)
      VALUES ('wish:2026-09-30:1', '2026-09-30', 'wish', 1, 'Anu', '1@g.us', 'Youth', 'sent', 1, 'M1', '2026-09-30T02:30:00Z', '2026-09-30T02:30:01Z')`);
    raw.close();
    const db = openDb(file);
    const kept = db.deliveries.get("wish:2026-09-30:1");
    assert.deepEqual([kept.status, kept.message_id, kept.chat_subject, kept.updated_at, kept.text, kept.alerted_at], ["sent", "M1", "Youth", "2026-09-30T02:30:01Z", null, null]);
    db.alerts.create({ key: "alert:wish:2026-09-30:1", day: "2026-09-30", text: "⚠️ *Wish Calendar: a wish was not sent*", about: ["wish:2026-09-30:1"] }, "2026-09-30T03:00:00.000Z");
    assert.equal(db.deliveries.get("wish:2026-09-30:1").alerted_at, "2026-09-30T03:00:00.000Z");
    assert.deepEqual(db.alerts.unsent("2026-09-30T00:00:00.000Z").map((a) => [a.key, a.kind, a.status, a.attempts]), [["alert:wish:2026-09-30:1", "alert", "pending", 0]]);
    assert.deepEqual(db.alerts.unsent("2026-09-30T03:00:00.001Z"), [], "only those made since");
    assert.equal(db.alerts.checkedThrough(), null);
    db.alerts.setCheckedThrough("2026-09-29");
    assert.equal(db.alerts.checkedThrough(), "2026-09-29");
    assert.equal(db.settings.get().alertTo, "self", "alerts go to the linked phone unless changed");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration 6 adds the notebook: notes, journal pages, tags and search", () => {
  const dir = mkdtempSync(join(tmpdir(), "bdr-"));
  try {
    const file = join(dir, "birthdays.db");
    firstVersionDb(file);
    const db = openDb(file);
    assert.equal(db.people.count(), 3, "the list is kept");

    const gift = db.notes.create({ title: "Gift ideas", body: "A fountain pen for Anu #Gifts", personId: 1, pinned: true });
    const dentist = db.notes.create({ body: "Dentist on Tuesday #health" });
    assert.deepEqual(db.notes.get(gift).tags, ["gifts"]);
    assert.deepEqual(db.notes.get(gift).person, { id: 1, name: "Anu", kind: "birthday" });
    assert.deepEqual(db.notes.list().map((n) => n.id), [gift, dentist], "pinned first");

    // Search follows every change: a new word is found, an old one is not.
    const found = (words) => db.notes.search(words.split(" ").map((w) => `"${w}"*`).join(" ")).map((n) => n.id);
    assert.deepEqual(found("dent"), [dentist]);
    db.notes.update(dentist, { body: "Physio on Tuesday #health" });
    assert.deepEqual(found("dent"), []);
    assert.deepEqual(found("physio tues"), [dentist]);
    assert.match(db.notes.search('"physio"*')[0].snippet, /\u0001Physio\u0002 on Tuesday/);

    // One journal page a day; saved again, it is the same page; saved empty, it goes.
    db.journal.save("2026-10-08", "Walked by the lake #health");
    db.journal.save("2026-10-08", "Walked by the lake, then the café #health");
    assert.equal(db.journal.count(), 1);
    assert.deepEqual(found("cafe"), [db.journal.get("2026-10-08").id], "accents do not matter");
    assert.deepEqual(db.notes.list({ tag: "health" }).map((n) => n.kind).sort(), ["journal", "note"], "a tag finds both");
    assert.deepEqual(db.notes.list().map((n) => n.kind), ["note", "note"], "the plain list is notes only");
    assert.deepEqual(db.notes.tags(), [{ tag: "health", count: 2 }, { tag: "gifts", count: 1 }]);
    db.journal.save("2026-10-08", "  \n ");
    assert.equal(db.journal.get("2026-10-08"), null);
    assert.deepEqual(found("lake"), []);

    // Deleting the person keeps the note about them.
    db.people.remove(1);
    assert.equal(db.notes.get(gift).person, null);
    assert.equal(db.notes.get(gift).title, "Gift ideas");

    // Pinning is not an edit; deleting takes the note out of search too.
    const edited = db.notes.get(gift).updatedAt;
    db.notes.setPinned(gift, false);
    assert.equal(db.notes.get(gift).updatedAt, edited);
    assert.equal(db.notes.remove(gift), true);
    assert.deepEqual(found("fountain"), []);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
