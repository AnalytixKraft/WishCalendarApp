#!/usr/bin/env bash
#
# Put a backup from scripts/backup.sh back in place of the app's database.
# Everything since that backup — people added, groups, settings, the record
# of what was sent — is replaced by what the backup holds.
#
#   bash scripts/restore.sh backups/birthdays-2026-09-30-120000.db
#
# The app is stopped while it happens and started again after.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

file=${1:-}
[[ -n $file ]] || { echo "usage: bash scripts/restore.sh backups/birthdays-<date>.db" >&2; exit 1; }
[[ -f $file ]] || { echo "restore: there is no file $file" >&2; exit 1; }
dir=$(cd "$(dirname "$file")" && pwd)
base=$(basename "$file")

docker compose stop app
# The -wal and -shm files belong to the database being replaced; left behind,
# SQLite would replay them onto the restored copy.
docker compose run --rm --no-deps -T -v "$dir:/restore:ro" app \
  sh -c 'rm -f /data/birthdays.db-wal /data/birthdays.db-shm && cp "/restore/$1" /data/birthdays.db' restore "$base"
docker compose start app

echo "restore: done — the app is running on $file"
