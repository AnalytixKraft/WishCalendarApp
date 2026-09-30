#!/usr/bin/env bash
#
# Put a backup from scripts/backup.sh back in place of the app's database.
# Everything since that backup — people added, settings, the record of what
# was sent — is replaced by what the backup holds.
#
#   bash scripts/restore.sh backups/birthdays-2026-09-30-120000.db
#
# The app is stopped while it happens and started again after — on this Mac
# or in Docker, whichever runs it.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

file=${1:-}
[[ -n $file ]] || fail "usage: bash scripts/restore.sh backups/birthdays-<date>.db"
[[ -f $file ]] || fail "there is no file $file"
dir=$(cd "$(dirname "$file")" && pwd)
base=$(basename "$file")

MODE=$(detect_mode)
if [[ $MODE == docker ]]; then
  docker compose stop app
  # The -wal and -shm files belong to the database being replaced; left
  # behind, SQLite would replay them onto the restored copy.
  docker compose run --rm --no-deps -T -v "$dir:/restore:ro" app \
    sh -c 'rm -f /data/birthdays.db-wal /data/birthdays.db-shm && cp "/restore/$1" /data/birthdays.db' restore "$base"
  docker compose start app
else
  running=0
  if launchctl print "$GUI/$LABEL_PREFIX.app" >/dev/null 2>&1; then
    running=1
    launchctl bootout "$GUI/$LABEL_PREFIX.app"
  fi
  umask 077
  mkdir -p "$APP_DATA"
  rm -f "${APP_DATA:?}/birthdays.db-wal" "${APP_DATA:?}/birthdays.db-shm"
  cp "$dir/$base" "$APP_DATA/birthdays.db"
  if (( running )); then launchctl bootstrap "$GUI" "$AGENTS_DIR/$LABEL_PREFIX.app.plist"; fi
fi
say "done — the app is running on $file"
