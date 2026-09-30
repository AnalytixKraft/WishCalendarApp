#!/usr/bin/env bash
#
# Run Wish Calendar on this Mac without Docker. Installs the Node packages and
# two launchd agents — the app, and the WhatsApp bridge — that start when you
# sign in and start again if they ever stop. Run it again after an update
# (git pull): it reinstalls and restarts both.
#
#   bash scripts/native/install.sh             install, and start
#   bash scripts/native/install.sh --dry-run   check everything, change nothing
#
# Moving from the Docker version? Run migrate-from-docker.sh first: it brings
# the database and the WhatsApp link across.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
dry=0
[[ ${1:-} == --dry-run ]] && dry=1
cd "$ROOT"

[[ $(uname) == Darwin ]] || fail "this is for macOS (launchd). Elsewhere, run it with Docker — see README.md."
[[ -f $ENV_FILE ]] || { (( dry )) && fail "no .env yet — run: bash scripts/setup.sh"; bash scripts/setup.sh; }
NODE=$(find_node) || fail "no Node 22.13 or newer found (fnm, nvm or Homebrew)"
say "Node $("$NODE" -v) — $NODE"

# Never beside the Docker version: two bridges on one WhatsApp session take
# it from each other, and two apps would each send the day's messages.
if command -v docker >/dev/null 2>&1 && docker compose ps --status running --services 2>/dev/null | grep -qE '^(app|whatsapp)$'; then
  fail "the Docker version is running. Bring its data across first: bash scripts/native/migrate-from-docker.sh"
fi

xml() { local s=${1//&/&amp;}; s=${s//</&lt;}; printf '%s' "${s//>/&gt;}"; }
agent() { # agent <part> <what it is> → the plist
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL_PREFIX.$1</string>
  <key>Comment</key><string>Wish Calendar — $(xml "$2")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml "$ROOT/scripts/native/run.sh")</string>
    <string>$1</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>StandardOutPath</key><string>$(xml "$LOG_DIR/launchd.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG_DIR/launchd.log")</string>
</dict>
</plist>
PLIST
}

check=$(mktemp -d)
agent whatsapp "the WhatsApp bridge" >"$check/whatsapp.plist"
agent app "the pages and the daily clock" >"$check/app.plist"
plutil -lint "$check"/*.plist >/dev/null || fail "the agents did not come out as valid plists"
if (( dry )); then
  say "dry run: Node, .env and both agents check out; nothing was installed."
  rm -rf "${check:?}"
  exit 0
fi

say "installing the Node packages"
export PATH="$(dirname "$NODE"):$PATH" # npm with the same Node
(cd app && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
(cd whatsapp && npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund --loglevel=error)

mkdir -p "$APP_DATA" "$BRIDGE_DATA" "$LOG_DIR" "$AGENTS_DIR"
chmod 700 "$SUPPORT_DIR"
for part in whatsapp app; do
  launchctl bootout "$GUI/$LABEL_PREFIX.$part" 2>/dev/null || true
  mv -f "$check/$part.plist" "$AGENTS_DIR/$LABEL_PREFIX.$part.plist"
  launchctl bootstrap "$GUI" "$AGENTS_DIR/$LABEL_PREFIX.$part.plist"
done
rm -rf "${check:?}"

load_env
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${APP_PORT:-3210}/healthz" >/dev/null 2>&1 &&
    curl -fsS "http://127.0.0.1:${BRIDGE_PORT:-3000}/healthz" >/dev/null 2>&1 && break
  sleep 1
done
bash "$ROOT/scripts/native/status.sh"
