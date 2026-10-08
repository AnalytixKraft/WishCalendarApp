# WhatsApp bridge

A small container that holds one WhatsApp **linked-device** session and does
two things with it: send text — into a group, or to a person by phone number —
and hand the app the **📅 messages** the account's owner sends, to put on the
calendar. The app decides what to send, to whom and when; this delivers it. Service `whatsapp` in
[`../docker-compose.yml`](../docker-compose.yml).

```
app ── whatsapp network, Bearer token ──► whatsapp.:3000 (this)
                                            └─(wss)──► web.whatsapp.com, as a linked
                                                       device of a SPARE number
```

Node, [Baileys](https://github.com/WhiskeySockets/Baileys) and pino — nothing
else. Adapted from the bridge AnalytixKraft runs for its bug tracker (itself
lifted from [AnalytixKraft/medha](https://github.com/AnalytixKraft/medha)),
keeping the text path only, and adding messages to people's numbers.

> **Use a spare number.** Driving an account from an unofficial client is
> against WhatsApp's Terms of Service and can get the number banned, with no
> warning. A ban takes the whole account, every chat on it included.

## What it will and will not do

- Sends **text** into **groups** the linked number is already a member of
  (`^\d+(-\d+)?@g\.us$`), or to **a person by phone number**
  (`^[1-9]\d{7,14}@s\.whatsapp\.net$`, country code first). The API refuses
  every other chat id — a LID, a broadcast list, a channel, a status.
- A message to a number goes only to a number WhatsApp says it knows
  (`onWhatsApp`, asked once a day per number), and at most **30 an hour**:
  direct messages from an unofficial client are what WhatsApp's spam checks
  look for, and the cap keeps a loop or a leaked token from becoming a burst.
- Acts on one kind of inbound message only: a **📅 message** — one the linked
  account sent *itself* (from the phone, or another of its devices), into a
  group or into its own chat (*Message yourself*), starting with 📅 or 📆
  ([`src/commands.mjs`](src/commands.mjs)). Its text, and the text of the
  message it replies to, are held in memory — never on disk, never in the
  log — until the app takes them (`GET /commands`, `POST /commands/ack`): at
  most 100, for at most 3 days. Every other message is let go of as it
  arrives, unread beyond that check: above all, **everything anyone else
  sends** — no one else can put anything on the calendar. What the bridge
  sends itself never comes back to it as an incoming message
  (`emitOwnEvents: false`), and nothing it sends starts with 📅 or 📆.
- Otherwise reads, stores and reacts to nothing inbound: no history sync, no
  message store. Baileys is told to drop everything that is
  not from a group, from the linked account itself, or from someone the bridge
  has sent a direct message to **before decrypting it** (`shouldIgnoreJid` →
  `ignoresSender` in [`src/session.mjs`](src/session.mjs)). That last set is
  there because a person's receipts — among them the retry receipt their phone
  sends when it cannot decrypt a message — come from their own JID; it holds
  their phone-number JID and, once WhatsApp has said, their LID, in memory
  only. What members post in a group the number is in, and a reply from
  someone it messaged, are still decrypted — the hook sees only the JID — and
  nothing acts on either: only the owner's own 📅 messages are kept.
- Publishes no port and is not in the tunnel: only the app, on the `whatsapp`
  compose network, can reach it — and every call but `/healthz` needs the token
  anyway.
- Connects out to `web.whatsapp.com:443` only. Logs a person's number as its
  last four digits.
- Never tries to connect while nobody has asked it to link a phone (`idle`),
  and never fights another client for the session (`conflict`).

## States

`GET /status` reports one of these as `state`:

| State | Means | Leaves it when |
|---|---|---|
| `unconfigured` | No `BRIDGE_TOKEN` (or under 32 characters). WhatsApp is never contacted. Every call but `/healthz` answers 503. | `bash scripts/setup.sh`, then `docker compose up -d` |
| `idle` | No linked device, and not trying | `POST /pair` |
| `pairing` | A QR is on offer in `qr`. It rotates (60 s, then every 20 s); after ~2.5 min unscanned it gives up → `idle` with `last_error` | Scanned → `connecting`; timeout → `idle` |
| `connecting` | Has a linked device; connecting, or backing off between tries (2 s doubling to 60 s, forever) | `open` |
| `open` | Connected; `me` says as whom | A disconnect → `connecting` |
| `conflict` | Another client took this session over (440). Stopped on purpose: reconnecting would kick the other one off in turn, forever | Stop the other client, then `docker compose restart whatsapp` — or Unlink and link again |

On start: credentials on disk → `connecting`, none → `idle`.

| WhatsApp says | The bridge |
|---|---|
| 515 `restartRequired` | reconnects immediately — routine, always right after a scan |
| 401 `loggedOut` | wipes the session → `idle`. The device was removed on the phone, or the phone went unused too long |
| 403 `forbidden` | wipes the session → `idle`. WhatsApp refused the number — possibly banned |
| 440 `connectionReplaced` | → `conflict`, keeps the session, stops |
| anything else | backs off and reconnects, without limit |

## API

Base `http://whatsapp.:3000`, as the app calls it. The trailing dot is
deliberate: an absolute name never walks the host's search domains, so a
stopped bridge fails closed instead of the token going to whatever answers
`whatsapp.<search-domain>`. Everything except `/healthz` needs
`Authorization: Bearer <BRIDGE_TOKEN>` — else `401 {"error":"unauthorized"}`.
Bodies are JSON; an error is `{"error": "<code>"}`, plus `state` on
`not_connected` and `bridge_token_not_configured`, and a `message` where there
is something to add.

| | |
|---|---|
| `GET /healthz` | `200 {"ok":true}` while the process is alive. No auth, no state: the container healthcheck. |
| `GET /status` | `200 {"state","me","qr","qr_expires_at","since","last_error","baileys_version","wa_version","features"}`. `me` is `{"id","name"}` once linked; `qr` is the raw QR payload while `pairing`, else `null`. `features` is `["text","commands"]`. |
| `POST /pair` | Starts pairing if `idle`; a no-op otherwise. Returns the status body at once — poll `/status` for the QR. |
| `POST /logout` | Unlinks: tells WhatsApp if connected (so the phone's list drops the device), wipes `/data/auth`, → `idle`. |
| `GET /groups` | `200 {"groups":[{"id","subject","participants","announce","is_admin"}]}`, sorted by subject. `409 not_connected` unless `open`; `502 groups_failed` if WhatsApp does not answer. |
| `POST /send` | `{"chat_id","text","idempotency_key"}` → `200 {"message_id","chat_id","deduplicated"}`. `chat_id` is a group (`…@g.us`) or a phone number (`919876543210@s.whatsapp.net`). |
| `GET /commands` | `200 {"commands":[{"id","chat","chat_id","sent_at","text","quoted"}]}`: the 📅 messages held, oldest first. `chat` is `group` or `self`; `text` is what follows the 📅; `quoted` the text of the message it replies to, or `null`. In any state — it is the bridge's memory, not a call to WhatsApp. |
| `POST /commands/ack` | `{"ids":[…]}` → `200 {"acked"}`: the app has these; let them go. `400 invalid_ids` unless an array of up to 500 non-empty strings. The app's poller is the one caller: anything else taking them takes them off the calendar. |

`/send` refuses, in this order:

| Status | `error` | When |
|---|---|---|
| 413 | `payload_too_large` | body over 256 KB |
| 400 | `invalid_json` | body is not a JSON object |
| 400 | `invalid_chat_id` | neither a group (`^\d+(-\d+)?@g\.us$`) nor a phone number (`^[1-9]\d{7,14}@s\.whatsapp\.net$`) |
| 400 | `invalid_text` | not a string of 1–20 000 characters (code points), or blank |
| 400 | `missing_idempotency_key` | absent, blank, or over 200 characters |
| 409 | `not_connected` | not `open` (the body carries `state`) |
| 403 | `not_a_member` | the linked number is not in that group |
| 403 | `admins_only` | the group is set to "only admins can send", and the number is not an admin |
| 404 | `not_on_whatsapp` | a phone number WhatsApp does not know |
| 429 | `rate_limited` | a phone number, after 30 direct messages in the last hour |
| 502 | `send_failed` | WhatsApp refused it, or did not confirm within 30 s. `message` says which |

**Idempotency.** The same `idempotency_key` within 24 h returns the first
send's 200 with `"deduplicated": true`, and nothing is re-sent — checked before
the connection state, so a retry after a dropped connection still learns that
the first attempt landed. A request arriving while the same key is in flight
waits for it rather than sending again. The record is in memory: a bridge
restart forgets it, and the app's own delivery log is what stops a wish going
out twice.

## Operating it

```bash
docker compose logs --tail 50 whatsapp   # JSON lines; never the token, a QR or a message's text
```

`📅 message held for the app` (with `chat` and `message_id`) is a 📅 message
the owner sent; the app takes it within 15 seconds.

```bash
docker compose restart whatsapp          # keeps the link (a stop is never a logout)
```

`⚠️ DANGER: DISABLING ALL SYNC BY shouldSyncHistoryMsg …` on every connect is
**expected**: history sync is off so the bridge never copies the account's
chats, and Baileys warns because it also loses the initial LID↔phone-number
mappings; group sends look up any missing mapping from WhatsApp instead.

**The session is `/data/auth` in the `whatsapp_auth` volume**, and it is a live
credential for the WhatsApp account: anyone with those files can read and send
as that number. Files are written owner-only, and `scripts/backup.sh` leaves
the volume out on purpose. **Never run two bridges on one session** — copying
the volume to a second machine gets both a 440. Link each machine separately.

## Upgrading

Both version pins are deliberate. Baileys 7 is still a release candidate, so a
bump is a behaviour change to test, not a routine update.

**Node.** Take the new exact tag and its **multi-arch index** digest from the
registry, and use it in both `Dockerfile`s (this one and `app/`'s).

**Baileys (or pino).** Change the exact version in `package.json`, then
regenerate the lockfile with the npm **inside the pinned image**:

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/w -w /w \
  node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 \
  npm install --package-lock-only --ignore-scripts
```

Then build, and check before relying on it: run it once with no token (expect
503 and the log line), and once with a token on a throwaway volume (`POST
/pair` should reach `pairing` with a QR within seconds; `POST /logout` should
return it to `idle`). Then send one real message to a test group.
