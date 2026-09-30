#!/usr/bin/env bash
#
# Run Wish Calendar on this Mac without Docker. Copies this version of the
# code to ~/Library/Application Support/WishCalendar/release, installs its
# Node packages there, and two launchd agents — the app, and the WhatsApp
# bridge — that start when you sign in and start again if they ever stop.
#
# The agents run the copy, not this folder: editing the code here, or
# switching git branches, changes nothing until install.sh runs again. After
# an update (git pull), run it again: it puts the new version in place and
# restarts both, down for a few seconds.
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
    <string>$(xml "$SUPPORT_DIR/release/scripts/native/run.sh")</string>
    <string>$1</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WISH_CALENDAR_ENV</key><string>$(xml "$ENV_FILE")</string>
    <key>WISH_CALENDAR_HOME</key><string>$(xml "$SUPPORT_DIR")</string>
    <key>WISH_CALENDAR_LOGS</key><string>$(xml "$LOG_DIR")</string>
  </dict>
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

mkdir -p "$APP_DATA" "$BRIDGE_DATA" "$LOG_DIR" "$AGENTS_DIR"
chmod 700 "$SUPPORT_DIR"

# The new version, made ready beside the running one — packages and all —
# so the switch itself takes seconds.
say "copying this version and installing its Node packages"
stage="$SUPPORT_DIR/release.new"
rm -rf "${stage:?}"
mkdir -p "$stage/app" "$stage/whatsapp" "$stage/scripts/native"
cp -R app/package.json app/package-lock.json app/src app/public "$stage/app/"
cp -R whatsapp/package.json whatsapp/package-lock.json whatsapp/src "$stage/whatsapp/"
cp scripts/lib.sh "$stage/scripts/"
cp scripts/native/run.sh "$stage/scripts/native/"
export PATH="$(dirname "$NODE"):$PATH" # npm with the same Node
(cd "$stage/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
(cd "$stage/whatsapp" && npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund --loglevel=error)

# The switch. The old version stops — waited for, not assumed: launchd
# refuses to start a label that is still stopping — then the new one starts,
# and both must answer. If anything fails once the old one is stopped, the
# old one goes back in and starts again: an update never leaves it down.
load_env
APP_PORT=${APP_PORT:-3210}
BRIDGE_PORT=${BRIDGE_PORT:-3000}
is_loaded() { launchctl print "$GUI/$LABEL_PREFIX.$1" >/dev/null 2>&1; }
stop_part() {
  launchctl bootout "$GUI/$LABEL_PREFIX.$1" 2>/dev/null || true
  for _ in $(seq 1 60); do is_loaded "$1" || return 0; sleep 0.5; done
  return 1
}
start_part() {
  for _ in 1 2 3 4 5; do
    launchctl bootstrap "$GUI" "$AGENTS_DIR/$LABEL_PREFIX.$1.plist" 2>/dev/null && return 0
    sleep 2
  done
  return 1
}
healthy() {
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:$APP_PORT/healthz" >/dev/null 2>&1 &&
      curl -fsS "http://127.0.0.1:$BRIDGE_PORT/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

had_old=0
[[ -d $SUPPORT_DIR/release ]] && had_old=1
mkdir -p "$check/before"
for part in app whatsapp; do
  if [[ -f $AGENTS_DIR/$LABEL_PREFIX.$part.plist ]]; then cp "$AGENTS_DIR/$LABEL_PREFIX.$part.plist" "$check/before/$part.plist"; fi
done

rollback() {
  say "the new version did not come up ($1) — putting the one before back"
  for part in app whatsapp; do stop_part "$part" || true; done
  if (( had_old )) && [[ -d $SUPPORT_DIR/release.old ]]; then
    rm -rf "${SUPPORT_DIR:?}/release.failed"
    [[ -d $SUPPORT_DIR/release ]] && mv "$SUPPORT_DIR/release" "$SUPPORT_DIR/release.failed"
    mv "$SUPPORT_DIR/release.old" "$SUPPORT_DIR/release"
  fi
  for part in whatsapp app; do
    if [[ -f $check/before/$part.plist ]]; then cp "$check/before/$part.plist" "$AGENTS_DIR/$LABEL_PREFIX.$part.plist"; fi
    if [[ -f $AGENTS_DIR/$LABEL_PREFIX.$part.plist ]]; then start_part "$part" || true; fi
  done
  if healthy; then
    fail "rolled back — the version before is running again. What went wrong is in $LOG_DIR (the new version's files: $SUPPORT_DIR/release.failed)"
  fi
  fail "rolled back, but it is not answering either — see $LOG_DIR, and bash scripts/native/status.sh"
}

say "switching to it (a few seconds)"
for part in app whatsapp; do stop_part "$part" || rollback "$part would not stop"; done
rm -rf "${SUPPORT_DIR:?}/release.old"
if (( had_old )); then mv "$SUPPORT_DIR/release" "$SUPPORT_DIR/release.old"; fi
mv "$stage" "$SUPPORT_DIR/release"
for part in whatsapp app; do
  mv -f "$check/$part.plist" "$AGENTS_DIR/$LABEL_PREFIX.$part.plist"
  start_part "$part" || rollback "launchd would not start $part"
done
healthy || rollback "it did not answer within 30 seconds"
rm -rf "${SUPPORT_DIR:?}/release.old" "${SUPPORT_DIR:?}/release.failed" "${check:?}"
say "the new version is running"
bash "$ROOT/scripts/native/status.sh"
