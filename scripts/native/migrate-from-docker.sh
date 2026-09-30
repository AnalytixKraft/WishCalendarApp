#!/usr/bin/env bash
#
# Move from the Docker version to the Mac version: stops the Docker containers,
# copies the database and the WhatsApp link (no need to scan a QR again) to
# ~/Library/Application Support/WishCalendar, then removes the containers so
# the two can never run at once. The Docker volumes are left as they are, a
# backup — but never start that version again beside this one.
#
#   bash scripts/native/migrate-from-docker.sh
#   bash scripts/native/install.sh

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || fail "no docker command — nothing to move"
launchctl print "$GUI/$LABEL_PREFIX.whatsapp" >/dev/null 2>&1 && fail "the Mac version is already installed; stop it first (uninstall.sh)"
if [[ -e $APP_DATA/birthdays.db || -e $BRIDGE_DATA/auth ]] && [[ ${1:-} != --force ]]; then
  fail "$SUPPORT_DIR already has data; not overwriting it (--force to replace it)"
fi
docker compose ps -a --services 2>/dev/null | grep -qx app || fail "no Docker containers of this project to move from"

say "stopping the Docker version (it closes the database and saves the link)"
docker compose stop app whatsapp >/dev/null
umask 077
mkdir -p "$APP_DATA" "$BRIDGE_DATA"
chmod 700 "$SUPPORT_DIR"
rm -rf "${BRIDGE_DATA:?}/auth"
docker compose cp app:/data/. "$APP_DATA/" 2>/dev/null
docker compose cp whatsapp:/data/auth "$BRIDGE_DATA/" 2>/dev/null
chmod -R go-rwx "$SUPPORT_DIR"
[[ -f $APP_DATA/birthdays.db ]] || fail "the database did not come across; the Docker version is stopped, not removed (docker compose start)"
say "database: $(du -h "$APP_DATA/birthdays.db" | cut -f1); WhatsApp link: $(find "$BRIDGE_DATA/auth" -type f | wc -l | tr -d ' ') files"

say "removing the Docker containers (their volumes stay, as a backup)"
docker compose --profile tunnel down >/dev/null 2>&1
say "done. Now: bash scripts/native/install.sh"
