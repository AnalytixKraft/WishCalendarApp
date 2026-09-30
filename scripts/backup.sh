#!/usr/bin/env bash
#
# Copy the app's database — people, groups, settings, what was sent — out of
# Docker, into backups/birthdays-<date>-<time>.db. A consistent snapshot
# (SQLite's VACUUM INTO), so it is safe while the app runs.
#
#   bash scripts/backup.sh
#
# The WhatsApp link is NOT in it, on purpose: it is a live credential for the
# account. After a restore, link the phone again in Settings → WhatsApp.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mkdir -p backups
name="birthdays-$(date +%Y-%m-%d-%H%M%S).db"

docker compose exec -T app node --disable-warning=ExperimentalWarning -e '
  const { rmSync } = require("node:fs");
  const { DatabaseSync } = require("node:sqlite");
  rmSync("/data/backup.db", { force: true });
  new DatabaseSync("/data/birthdays.db").exec("VACUUM INTO '"'"'/data/backup.db'"'"'");
'
docker compose cp app:/data/backup.db "backups/$name" >/dev/null
docker compose exec -T app rm -f /data/backup.db

echo "backup: backups/$name"
