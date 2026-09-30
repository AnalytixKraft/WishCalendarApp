# Wish Calendar

Birthday and anniversary wishes for a community, sent on WhatsApp.

Keep the list in the app: 🎂 birthdays, and 💍 anniversaries (a couple's wedding day). For each one you choose where the wish goes — **a WhatsApp group, or straight to their own number** — what it says, and at what time. Every day it:

- sends **you a morning reminder** — every wish the day holds (its time, where it goes, what it says) and the birthdays and anniversaries coming up — to the linked phone, your own number, or a group, and
- sends **each wish** at its time, to where its row says.

It runs on a computer that stays on — a Mac, directly, with nothing but Node; or any computer with Docker — and you use it in the browser at `http://localhost:3210`.

> [!WARNING]
> **Link a spare WhatsApp number if you can, not your business one.** The app sends through WhatsApp Web as a *linked device* — an unofficial client, against WhatsApp's Terms of Service. WhatsApp can ban a number that uses one, with no warning, and the ban takes the whole account. A few messages a day is about as low-risk as this gets; it is not zero — and messages straight to people's numbers draw more attention than posts in groups.

## How it fits together

```
 you, in a browser ──► app ─────────────► whatsapp (the bridge) ──► WhatsApp
 (localhost:3210)      pages, the list,   a linked device of the
                       the daily clock,   number; posts into groups
                       SQLite database    and to people's numbers
```

- **`app/`** — the pages, the database (people, settings, what was sent — one SQLite file) and the clock that sends each day's messages. Node 24, no framework, SQLite built in.
- **`whatsapp/`** — the bridge: holds the WhatsApp session and does one thing with it — send text to a group it is in, or to a person's number. Only this computer (or, in Docker, only the app) can reach it, and only with the token. It only messages numbers that are on WhatsApp, at most 30 direct messages an hour, and ignores messages from strangers. See [`whatsapp/README.md`](whatsapp/README.md).

Two ways to run the pair: **on a Mac, directly** — two small Node programs that macOS's launchd starts when you sign in and restarts if they stop — or **in Docker**, on any computer (plus an optional Cloudflare tunnel; see [Reach it from anywhere](#reach-it-from-anywhere)).

## Set it up

```bash
git clone https://github.com/AnalytixKraft/WishCalendarApp.git
```

```bash
cd WishCalendarApp
```

```bash
bash scripts/setup.sh
```

`setup.sh` creates `.env` and fills in the secrets. Run in a terminal, it asks you to choose the app's password (or makes one up; see it with `grep ADMIN_PASSWORD .env`). Then start it, one of two ways.

**On a Mac, without Docker** — needs Node 22.13 or newer (fnm, nvm or Homebrew; the newest one found is used):

```bash
bash scripts/native/install.sh
```

That copies this version of the code to `~/Library/Application Support/WishCalendar/release`, installs its Node packages there, and two launchd agents — the app and the WhatsApp bridge — that start when you sign in and start again if they ever stop. They run that copy, so editing this folder or switching git branches changes nothing until you run `install.sh` again (after `git pull`, say). An update stops the old version, starts the new one and checks both answer — a couple of seconds — and if the new one does not come up, it puts the old one back and starts it again, so an update never leaves it down. Data lives in `~/Library/Application Support/WishCalendar`, logs in `~/Library/Logs/WishCalendar`. Both listen on 127.0.0.1 only. `scripts/native/status.sh` says how it is; `scripts/native/uninstall.sh` stops it and keeps the data.

**In Docker** — any computer with [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine:

```bash
docker compose up -d --build
```

Moving from Docker to the Mac version? `bash scripts/native/migrate-from-docker.sh` stops the Docker containers and brings the database and the WhatsApp link across — no QR to scan again — then run `install.sh`. Never run the two side by side: two bridges on one WhatsApp link take it from each other.

Open <http://localhost:3210>, sign in, and follow **Getting started** on the Today page:

1. **Link the WhatsApp number.** Settings → WhatsApp → *Link a phone*. On the phone: WhatsApp → Settings → Linked devices → Link a device, and scan the code.
2. **Upload your list** on *People → Upload a list* — or use *Add birthday* and *Add anniversary*.
3. **Choose where each wish goes.** On the People page, each row has a *Send wish to* — their own number, or one of the groups the linked number is in — a *Time* and a *Message*. An empty time is the wish time in Settings; an empty message is the default for its occasion. Then *Save changes*.
4. **Choose where your reminder goes, and turn sending on** in Settings: *This WhatsApp — the linked phone* puts the morning reminder in the linked phone's own chat (Message yourself). *Send wishes and reminders automatically* is the master switch: unticked, nothing goes out on its own (the Send now buttons still work).

To post in a group, the linked number has to be a member; if the group only lets admins send messages, make it an admin.

### Uploading a list

Upload a CSV file, or paste rows copied from Excel or Google Sheets. Only a name and a date are needed; with a header row the columns can be in any order:

```
Name            Birthday      Anniversary   WhatsApp number   Send to            Message                    Time
Anu Joseph      30-09-1996                  98765 43210       direct             Happy birthday, Anu! 🎂    09:30
Joseph & Mary                 15-05-1995                      St. Mary's Youth
Biju Thomas     5 Oct         12 Jan
```

- A row can have a **Birthday**, an **Anniversary** (the wedding day), or both — a row with both adds both. A list with a single **Date** column can say which in an **Occasion** column (birthday / anniversary).
- Dates are read **day first** (30-09-1996, 30/09, 30 Sep, 1996-09-30); the year is optional and lets messages say the age they turn, or the years married.
- Numbers without a country code get the one in Settings (+91 unless you change it).
- *Send to* is a group's name, or `direct` for their own number. Left empty, choose it on the People page.
- A bad number, an unknown group or an odd time does not stop the person being added — that detail is left blank, and the page lists them for you to fill in.
- On a row with both dates, *Message* is the birthday's; an *Anniversary message* column is the anniversary's.
- A birthday or anniversary already on the list (same name, occasion and date) is skipped, so a corrected list can be uploaded again.

### Messages

Each row's *Message* is what its wish says. Left empty, it sends the **default message** for its occasion — one for birthdays, one for anniversaries — which you edit in the *Default messages* panel at the top of the People page (or in Settings).

To change the default for one person, click into their empty message box: the default comes in with their name already in it, ready to edit. Left unchanged, the box empties again and keeps following the default. A person's page previews the wish as it will look in WhatsApp. A message can contain:

| | becomes |
|---|---|
| `{name}` | their name — or the couple's — as on the list |
| `{first_name}` | the first word of the name |
| `{years}` | the age they turn, or the years married — left out when the year is not known (`{age}` works too) |
| `{ordinal}` | 30th, 25th… — left out when not known (`{ordinal_age}` works too) |
| `{group}` | the group's name — left out when the wish goes to their number |

WhatsApp formatting works: `*bold*`, `_italic_`. A 29 February birthday or anniversary is wished on 28 February in other years.

### Send now, and previews

- **Send now** (on each row of the People table, and on a person's page) sends that wish straight away. On the day itself it *is* the day's wish — sent now instead of at its time, and not again. On any other day it is an extra message, and the wish on the day still goes out.
- **Send me a preview** (on a person's page) sends their wish, as they will get it, to your number in Settings — or to the linked phone if you left that empty.

### The morning reminder

At the reminder time (06:00 unless you change it) the app sends you the day's plan — before any wish goes out:

```
🎉 Today's wishes · Wed 30 Sep

• 08:00 → St. Mary's Youth — 🎂 Biju Thomas
> Happy birthday, Biju! 🎉

• 08:00 → St. Mary's Youth — 💍 Joseph & Mary (25 years)
> Happy anniversary, Joseph & Mary! 💍

⚠️ 🎂 Mary K — no “Send to” chosen, so nothing will be sent

• 09:30 → +91 98765 43210 — 🎂 Anu Joseph (turns 30)
> Happy birthday, Anu! 🎂

Coming up
• Tomorrow — 🎂 Jose P
```

It goes to the linked phone, your own number, or a group (Settings → *Send my daily reminder to*); on a day with nothing to say, it is not sent.

### The password

The first password is `ADMIN_PASSWORD` in `.env` (`setup.sh` asked for it, or made one up: `grep ADMIN_PASSWORD .env`). Change it in **Settings → Password** — that needs the current one, and signs out every other browser. The new one is kept as a salted scrypt hash in the app's database, never as the password itself.

Forgot it? The sign-in page offers no reset — anyone who can reach the page could use one. On the computer that runs the app:

```bash
bash scripts/reset-password.sh
```

That removes the password set in Settings, so `ADMIN_PASSWORD` from `.env` works again.

## Keep it running

- **On a Mac, directly**: launchd starts both parts when you sign in and restarts them if they stop — nothing to set.
- **In Docker**: the containers restart on their own (`restart: unless-stopped`) — as long as Docker itself starts. In Docker Desktop: **Settings → General → Start Docker Desktop when you sign in**.
- A sleeping Mac runs nothing. Stop it sleeping: **System Settings → Battery (or Energy) → Prevent automatic sleeping when the display is off**, on power adapter — and on a MacBook, keep the lid open.
- If the computer is off or asleep at a message's time, it goes out as soon as the computer is back — later that day, never twice, and never on a later day.
- **Open WhatsApp on the linked phone at least every two weeks.** WhatsApp unlinks devices whose phone has been offline for about 14 days; Settings → WhatsApp then asks you to link it again.

## Reach it from anywhere

The app listens on `127.0.0.1` only. To use it from your phone or share it with a co-organiser, put it behind a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) on a hostname of yours:

1. In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a tunnel** (type *Cloudflared*). Copy its token.
2. Add a **public hostname** to the tunnel — say `birthdays.example.com` — with service **`http://app:3210`**.
3. Put the token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN=…`, then:

```bash
docker compose --profile tunnel up -d
```

Without a token, `cloudflared` cannot start. The tunnel reaches the app's pages only, never the bridge. (Running on the Mac without Docker, run `cloudflared` itself and point the hostname at `http://localhost:3210`.) The pages need the password, and failed sign-ins are throttled; for more, put a Cloudflare Access policy in front of the hostname.

## Day to day

On a Mac, without Docker:

```bash
bash scripts/native/status.sh                  # running? WhatsApp connected?
```

```bash
tail -n 50 ~/Library/Logs/WishCalendar/app.log # what was sent, and what failed
```

In Docker:

```bash
docker compose ps                   # both should say (healthy)
```

```bash
docker compose logs --tail 50 app   # what was sent, and what failed
```

Either way — the scripts find where it runs:

```bash
bash scripts/backup.sh              # the database, into backups/
```

```bash
bash scripts/restore.sh backups/birthdays-2026-09-30-120000.db
```

A backup holds people, settings and the record of what was sent. It does not hold the WhatsApp link — after restoring on a new computer, link the phone again.

To update to a newer version: `git pull`, then `bash scripts/native/install.sh` (Mac) or `docker compose up -d --build` (Docker).

### When something is not sent

The Today page lists each of the day's messages and where it stands; a message WhatsApp refused says why, and *Retry now* tries again. The app also retries on its own every 10 minutes, up to 6 times a day.

| The page says | Do this |
|---|---|
| No “Send to” chosen | People page: choose where their wish goes |
| WhatsApp is not connected | Settings → WhatsApp: link the phone again (it may have been offline for 2 weeks, or the device was removed on it) |
| That number is not on WhatsApp | Check the number on the People page — with the country code |
| Not a member of this group | Add the linked number to the group on WhatsApp, then *Retry now* |
| Only admins can send messages | Make the linked number a group admin, then *Retry now* |
| Too many direct messages this hour | Nothing — the rest go out on the next tries |
| The WhatsApp bridge is not answering | Mac: `bash scripts/native/status.sh`, and its log in `~/Library/Logs/WishCalendar`. Docker: `docker compose ps`, then `docker compose up -d` |
| The app and the bridge hold different tokens | Mac: `bash scripts/native/install.sh`. Docker: `docker compose up -d` (not `restart`) — so both read `.env` again |
| WhatsApp refused this number — possibly banned | Link a different number |

## Development

```bash
cd app && npm ci && npm test
```

The app is plain Node 24 (`node:http`, `node:sqlite`, `node:test`), with one dependency to draw the QR code. The pages are rendered on the server; `app/public/app.js` only adds confirmations, the list filter, reading an uploaded file, the live wish preview and QR refresh. Every page but sign-in needs the session cookie, every form post must come from the app's own pages, and the Content-Security-Policy allows no inline script and nothing from other sites.

Test anything that sends against a fake bridge, never a linked one: the tests' fakes in `app/test/`, or the app run outside Docker with `BRIDGE_URL` pointing at a stub:

```bash
cd app && BRIDGE_URL=http://127.0.0.1:3999 BRIDGE_TOKEN=… ADMIN_PASSWORD=… SESSION_SECRET=… DATA_DIR=./data PORT=3211 npm start
```

## Credits

The WhatsApp bridge is adapted from the one AnalytixKraft runs for its bug tracker, itself lifted from [AnalytixKraft/medha](https://github.com/AnalytixKraft/medha). It is built on [Baileys](https://github.com/WhiskeySockets/Baileys) (MIT). QR codes by [uqr](https://github.com/unjs/uqr) (MIT).

MIT licensed — see [LICENSE](LICENSE).
