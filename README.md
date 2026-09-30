# Birthday Reminder

Birthday wishes and reminders for a community, sent on WhatsApp.

Keep the list of people and their birthdays in the app. Every day it:

- posts **a reminder to you** — today's birthdays and the next few days' — at the time you choose, and
- posts **a birthday wish** into the community's WhatsApp group(s), for each person whose birthday it is.

It runs on a computer that stays on (a Mac, a PC, a small server) with Docker, and you use it in the browser at `http://localhost:3210` — or from anywhere, through a Cloudflare tunnel.

> [!WARNING]
> **Link a spare WhatsApp number, not your personal or business one.** The app sends through WhatsApp Web as a *linked device*, which is an unofficial client, against WhatsApp's Terms of Service. WhatsApp can ban a number that uses one, with no warning, and the ban takes the whole account. A few messages a day to groups you are in is about as low-risk as this gets; it is not zero.

## How it fits together

```
 you, in a browser ──► app ─────────────► whatsapp (the bridge) ──► WhatsApp
 (localhost:3210, or   pages, the list,   a linked device of the
  your tunnel's        the daily clock    spare number; posts into
  hostname)            SQLite database    groups only
```

- **`app/`** — the pages, the database (people, groups, settings, what was sent) and the clock that sends each day's messages. Node 24, no framework, SQLite built in.
- **`whatsapp/`** — the bridge: holds the WhatsApp session and can do one thing with it, post text into a group it is a member of. It is not reachable from outside Docker, and cannot message a person. See [`whatsapp/README.md`](whatsapp/README.md).
- **`cloudflared`** (optional) — a Cloudflare tunnel to the app's pages, and only to them.

Because the bridge posts into **groups only**, the reminder "to you" goes to a small WhatsApp group with just you and the spare number in it. You'll get a notification like any other message.

## Set it up

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac or Windows) or Docker Engine (Linux), and git.

```bash
git clone https://github.com/AnalytixKraft/BirthdayReminderApp.git
```

```bash
cd BirthdayReminderApp
```

```bash
bash scripts/setup.sh
```

`setup.sh` creates `.env` and fills in the secrets. Run in a terminal, it asks you to choose the app's password (or makes one up; see it with `grep ADMIN_PASSWORD .env`). Then start it:

```bash
docker compose up -d --build
```

Open <http://localhost:3210>, sign in, and follow **Getting started** on the Today page:

1. **Link the WhatsApp number.** WhatsApp page → *Link a phone*. On the spare phone: WhatsApp → Settings → Linked devices → Link a device, and scan the code.
2. **Add the groups.** On WhatsApp, add the spare number to the community group, and create a group with just you and the spare number for your reminders. Then on the Groups page: *Add for wishes* on the community group, *Add for my reminder* on yours. If the community group only lets admins send messages, make the spare number an admin.
3. **Add people** one by one, or paste your list on *People → Import a list* (see below).
4. **Turn sending on** in Settings, and set the times: the reminder at 07:00 and the wishes at 08:00 unless you change them.

Before turning sending on, *Send a test message* on the Groups page checks that the number can post in a group.

### Importing a list

Paste rows straight from a spreadsheet, or the text of a CSV file — name, birthday, and optionally groups and notes:

```
Name          Birthday      Groups
Anu Joseph    30-09-1996    St. Mary's Youth
Biju Thomas   5 Oct
```

Birthdays are read **day first** (30-09-1996, 30/09, 30 Sep, 1996-09-30); the year is optional and, when given, lets messages say the age they turn. Groups are group names, separated by `;` — left empty, the person is wished in every group that has wishes on. Anyone already on the list with the same name and birthday is skipped, so a corrected list can be pasted again.

### The wish message

Each group can have its own message; otherwise the default from Settings is used. The Groups page previews it as it will look in WhatsApp. It can contain:

| | becomes |
|---|---|
| `{name}` | their name, as on the list |
| `{first_name}` | the first word of their name |
| `{age}` | the age they turn — left out when the birth year is not known |
| `{ordinal_age}` | 30th, 41st… — left out when not known |
| `{group}` | the group's name |

WhatsApp formatting works: `*bold*`, `_italic_`. People born on 29 February are wished on 28 February in other years.

## Keep it running

- The containers restart on their own (`restart: unless-stopped`), including after a reboot — as long as Docker itself starts. In Docker Desktop: **Settings → General → Start Docker Desktop when you sign in**.
- On a Mac, stop it sleeping: **System Settings → Battery (or Energy) → Prevent automatic sleeping when the display is off**, on power adapter.
- If the computer is off or asleep at the set time, the day's messages go out as soon as it is back — later that day, never twice, and never on a later day.
- **Open WhatsApp on the spare phone at least every two weeks.** WhatsApp unlinks devices whose phone has been offline for about 14 days; the WhatsApp page then asks you to link it again.

## Reach it from anywhere

The app listens on `127.0.0.1` only. To use it from your phone or share it with a co-organiser, put it behind a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) on a hostname of yours:

1. In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a tunnel** (type *Cloudflared*). Copy its token.
2. Add a **public hostname** to the tunnel — say `birthdays.example.com` — with service **`http://app:3210`**.
3. Put the token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN=…`, then:

```bash
docker compose --profile tunnel up -d
```

The tunnel reaches the app's pages only, never the bridge. The pages need the password, and failed sign-ins are throttled; for more, put a Cloudflare Access policy (for example, a one-time PIN to your email) in front of the hostname.

Already running `cloudflared` on the computer itself? Point a hostname at `http://localhost:3210` instead, and skip the `tunnel` profile.

## Day to day

```bash
docker compose ps                   # both should say (healthy)
```

```bash
docker compose logs --tail 50 app   # what was sent, and what failed
```

```bash
bash scripts/backup.sh              # the database, into backups/
```

```bash
bash scripts/restore.sh backups/birthdays-2026-09-30-120000.db
```

A backup holds people, groups, settings and the record of what was sent. It does not hold the WhatsApp link — after restoring on a new computer, link the phone again.

To update to a newer version:

```bash
git pull && docker compose up -d --build
```

### When something is not sent

The Today page lists each of the day's messages and where it stands; a message WhatsApp refused says why, and *Retry now* tries again. The app also retries on its own every 10 minutes, up to 6 times a day.

| The page says | Do this |
|---|---|
| WhatsApp is not connected | WhatsApp page: link the phone again (the phone may have been offline for 2 weeks, or the device was removed on it) |
| Not a member of this group | Add the spare number to the group on WhatsApp, then *Retry now* |
| Only admins can send messages | Make the spare number a group admin, then *Retry now* |
| The WhatsApp bridge is not answering | `docker compose ps`, then `docker compose up -d` |
| The app and the bridge hold different tokens | `docker compose up -d` (not `restart`), so both read `.env` again |
| WhatsApp refused this number — possibly banned | Link a different spare number |

## Development

```bash
cd app && npm ci && npm test
```

The app is plain Node 24 (`node:http`, `node:sqlite`, `node:test`), with one dependency to draw the QR code. The pages are rendered on the server; `app/public/app.js` only adds confirmations, the list filter, the live wish preview and QR refresh. Every page but sign-in needs the session cookie, every form post must come from the app's own pages, and the Content-Security-Policy allows no inline script and nothing from other sites.

To run the app outside Docker, point it at a bridge and a data folder:

```bash
cd app && BRIDGE_URL=http://127.0.0.1:3000 BRIDGE_TOKEN=… ADMIN_PASSWORD=… SESSION_SECRET=… DATA_DIR=./data PORT=3210 npm start
```

## Credits

The WhatsApp bridge is adapted from the one AnalytixKraft runs for its bug tracker, itself lifted from [AnalytixKraft/medha](https://github.com/AnalytixKraft/medha). It is built on [Baileys](https://github.com/WhiskeySockets/Baileys) (MIT). QR codes by [uqr](https://github.com/unjs/uqr) (MIT).

MIT licensed — see [LICENSE](LICENSE).
