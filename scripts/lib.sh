# Sourced by the scripts in scripts/ — not run on its own. Where things are,
# which Node to use, and whether Wish Calendar runs on this Mac (launchd) or
# in Docker.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL_PREFIX="${WISH_CALENDAR_LABEL:-tech.analytixkraft.wishcalendar}"
SUPPORT_DIR="${WISH_CALENDAR_HOME:-$HOME/Library/Application Support/WishCalendar}"
LOG_DIR="${WISH_CALENDAR_LOGS:-$HOME/Library/Logs/WishCalendar}"
AGENTS_DIR="$HOME/Library/LaunchAgents"
ENV_FILE="${WISH_CALENDAR_ENV:-$ROOT/.env}"
APP_DATA="$SUPPORT_DIR/app"
BRIDGE_DATA="$SUPPORT_DIR/whatsapp"
GUI="gui/$(id -u)"

fail() { printf '%s: %s\n' "$(basename "$0" .sh)" "$*" >&2; exit 1; }
say() { printf '%s: %s\n' "$(basename "$0" .sh)" "$*"; }

load_env() {
  [[ -f $ENV_FILE ]] || fail "no $ENV_FILE — run: bash scripts/setup.sh"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

# The newest Node 22.13 or later on this Mac — fnm, nvm or Homebrew — so
# that upgrading or removing one version does not stop the service.
# WISH_CALENDAR_NODE (say, in .env) picks one instead.
find_node() {
  if [[ -n ${WISH_CALENDAR_NODE:-} && -x ${WISH_CALENDAR_NODE} ]]; then echo "$WISH_CALENDAR_NODE"; return 0; fi
  local best="" best_version=0 candidate version
  for candidate in \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@*/bin/node; do
    [[ -x $candidate ]] || continue
    version=$("$candidate" -p 'process.versions.node.split(".").reduce((a, n) => a * 1000 + Number(n), 0)' 2>/dev/null) || continue
    (( version >= 22013000 )) || continue # node:sqlite without a flag
    if (( version > best_version )); then best=$candidate; best_version=$version; fi
  done
  [[ -n $best ]] && echo "$best"
}

# native: the launchd agents are loaded. docker: its app container runs.
detect_mode() {
  if launchctl print "$GUI/$LABEL_PREFIX.app" >/dev/null 2>&1; then echo native; return; fi
  if command -v docker >/dev/null 2>&1 &&
    docker compose -f "$ROOT/docker-compose.yml" ps --status running --services 2>/dev/null | grep -qx app; then
    echo docker
    return
  fi
  echo none
}

# Runs JavaScript against the app's database, wherever it is: DATA_DIR is
# its folder. Native needs no running app; Docker needs its container.
app_node() {
  local js=$1 node
  case ${MODE:-$(detect_mode)} in
    docker) docker compose -f "$ROOT/docker-compose.yml" exec -T -e DATA_DIR=/data app node --disable-warning=ExperimentalWarning -e "$js" ;;
    *)
      node=$(find_node) || fail "no Node 22.13 or newer found"
      DATA_DIR="$APP_DATA" "$node" --disable-warning=ExperimentalWarning -e "$js"
      ;;
  esac
}
