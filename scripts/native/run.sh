#!/usr/bin/env bash
#
# What launchd runs (see install.sh): one part of Wish Calendar, in the
# foreground, with .env read and this Mac's paths filled in. Only this
# computer can reach either part: both listen on 127.0.0.1.
#
#   bash scripts/native/run.sh app        the pages and the daily clock
#   bash scripts/native/run.sh whatsapp   the WhatsApp bridge

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

part=${1:-}
[[ $part == app || $part == whatsapp ]] || fail "usage: run.sh app|whatsapp"
load_env
NODE=$(find_node) || fail "no Node 22.13 or newer found (fnm, nvm or Homebrew) — install one, or set WISH_CALENDAR_NODE in .env"

# Its own log, kept to about 5 MB: the one before is kept as .1.
mkdir -p "$LOG_DIR"
log="$LOG_DIR/$part.log"
if [[ -f $log ]] && (( $(stat -f %z "$log") > 5 * 1024 * 1024 )); then mv -f "$log" "$log.1"; fi
exec >>"$log" 2>&1

BRIDGE_PORT=${BRIDGE_PORT:-3000}
export NODE_ENV=production HOST=127.0.0.1 BRIDGE_TOKEN="${WHATSAPP_BRIDGE_TOKEN:-}"
umask 077
if [[ $part == app ]]; then
  mkdir -p "$APP_DATA"
  export DATA_DIR="$APP_DATA" PORT="${APP_PORT:-3210}" BRIDGE_URL="http://127.0.0.1:$BRIDGE_PORT"
  cd "$ROOT/app"
  exec "$NODE" --disable-warning=ExperimentalWarning src/main.mjs
else
  mkdir -p "$BRIDGE_DATA"
  export DATA_DIR="$BRIDGE_DATA" PORT="$BRIDGE_PORT"
  cd "$ROOT/whatsapp"
  exec "$NODE" src/main.mjs
fi
