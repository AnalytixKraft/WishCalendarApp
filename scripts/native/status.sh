#!/usr/bin/env bash
#
# Is Wish Calendar running on this Mac, and is WhatsApp connected?
#
#   bash scripts/native/status.sh

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
load_env

for part in app whatsapp; do
  if info=$(launchctl print "$GUI/$LABEL_PREFIX.$part" 2>/dev/null); then
    pid=$(awk '/^\tpid = / {print $3}' <<<"$info")
    if [[ -n $pid ]]; then say "$part: running (pid $pid)"; else say "$part: installed, not running right now — see $LOG_DIR/$part.log"; fi
  else
    say "$part: not installed (bash scripts/native/install.sh)"
  fi
done
if curl -fsS "http://127.0.0.1:${APP_PORT:-3210}/healthz" >/dev/null 2>&1; then
  say "the pages: http://localhost:${APP_PORT:-3210}"
else
  say "the pages: not answering"
fi
state=$(curl -fsS -H "Authorization: Bearer ${WHATSAPP_BRIDGE_TOKEN:-}" "http://127.0.0.1:${BRIDGE_PORT:-3000}/status" 2>/dev/null |
  sed -nE 's/.*"state":"([a-z]+)".*/\1/p') || true
say "WhatsApp: ${state:-not answering}"
say "logs: $LOG_DIR"
