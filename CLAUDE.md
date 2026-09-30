# Working in this repo

## Agents never send WhatsApp messages

**No agent sends a WhatsApp message — not to test, not "just once".** Only
the app's own scheduler sends, at the times its owner set. The bridge acts as
a real WhatsApp account that belongs to someone, and whatever it sends reaches
real people.

So, against a running app or bridge, an agent never:

- calls the bridge's `POST /send`;
- presses **Send today's messages now**, **Retry now**, **Send me a preview**,
  **Send a test message**, or any other button that sends;
- turns **Send messages** on in Settings;
- does anything else that makes WhatsApp deliver a message.

Reading is fine: the bridge's `GET /status` and `GET /healthz`,
`docker compose logs`, the database. Linking a phone (`POST /pair`) sends
nothing, but is only for a bridge that is `idle`, and only when a person asks.

Code that sends is tested against fakes that reach no one: the fake bridges in
`app/test/`, or a stub server with the app run outside Docker and `BRIDGE_URL`
pointing at it — never the `whatsapp` container. If checking a change seems to
need a real message, stop and ask a person to send it: say what to click and
what to look for.

The rule exists because it was broken once: an agent "checking" `/send`
against a bridge it believed was unlinked posted a real message from its
owner's number to a stranger.

## Where things are

- `app/` — the pages, the database and the scheduler. Tests:
  `cd app && npm ci && npm test`.
- `whatsapp/` — the bridge, the one piece that acts as a WhatsApp account.
  Read [`whatsapp/README.md`](whatsapp/README.md) before changing it: anything
  that widens what it can do widens what a ban or a leaked token can cost.
- [`README.md`](README.md) — running it; `scripts/` — setup, backup, restore.
