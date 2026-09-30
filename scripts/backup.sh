#!/usr/bin/env bash
#
# Copy the app's database — people, settings, what was sent — into
# backups/birthdays-<date>-<time>.db. A consistent snapshot (SQLite's
# VACUUM INTO), so it is safe while the app runs — on this Mac or in Docker.
#
#   bash scripts/backup.sh
#
# The WhatsApp link is NOT in it, on purpose: it is a live credential for the
# account. After a restore on another computer, link the phone again in
# Settings → WhatsApp.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

MODE=$(detect_mode)
mkdir -p backups
name="birthdays-$(date +%Y-%m-%d-%H%M%S).db"
snapshot='const { DatabaseSync } = require("node:sqlite");
  new DatabaseSync(process.env.DATA_DIR + "/birthdays.db").prepare("VACUUM INTO ?").run(process.env.BACKUP_TO);'

if [[ $MODE == docker ]]; then
  docker compose exec -T -e DATA_DIR=/data -e BACKUP_TO=/data/backup.db app sh -c 'rm -f /data/backup.db'
  docker compose exec -T -e DATA_DIR=/data -e BACKUP_TO=/data/backup.db app node --disable-warning=ExperimentalWarning -e "$snapshot"
  docker compose cp app:/data/backup.db "backups/$name" >/dev/null 2>&1
  docker compose exec -T app rm -f /data/backup.db
else
  [[ -f $APP_DATA/birthdays.db ]] || fail "no database at $APP_DATA — is Wish Calendar installed? (scripts/native/install.sh)"
  BACKUP_TO="$ROOT/backups/$name" app_node "$snapshot"
fi
say "backups/$name"
