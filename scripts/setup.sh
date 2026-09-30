#!/usr/bin/env bash
#
# Make .env ready: copy .env.example if there is no .env yet, then fill in
# ADMIN_PASSWORD, SESSION_SECRET and WHATSAPP_BRIDGE_TOKEN where they are
# missing or too short. A value that is already long enough is never
# changed, so running this again is safe.
#
#   bash scripts/setup.sh
#
# Asked for a password when run in a terminal; blank makes one up. The
# password is never printed — it is in .env (ADMIN_PASSWORD=).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v openssl >/dev/null 2>&1 || { echo "setup: openssl is needed to make the secrets." >&2; exit 1; }

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "setup: created .env from .env.example"
fi
chmod 600 .env

current() { grep -E "^$1=" .env | head -n 1 | cut -d= -f2- || true; }

# Replace (or add) KEY=value in .env. The value goes to awk through the
# environment, not -v, so no backslash or other character in it is
# interpreted on the way.
put() {
  local tmp
  tmp=$(mktemp)
  PUT_KEY=$1 PUT_VALUE=$2 awk '
    BEGIN { key = ENVIRON["PUT_KEY"]; value = ENVIRON["PUT_VALUE"]; done = 0 }
    index($0, key "=") == 1 && !done { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

changed=0

if [[ $(current SESSION_SECRET | tr -d '[:space:]' | wc -c) -lt 32 ]]; then
  put SESSION_SECRET "$(openssl rand -hex 32)"
  echo "setup: made SESSION_SECRET"
  changed=1
fi

if [[ $(current WHATSAPP_BRIDGE_TOKEN | tr -d '[:space:]' | wc -c) -lt 32 ]]; then
  put WHATSAPP_BRIDGE_TOKEN "$(openssl rand -hex 32)"
  echo "setup: made WHATSAPP_BRIDGE_TOKEN"
  changed=1
fi

if [[ $(current ADMIN_PASSWORD | tr -d '[:space:]' | wc -c) -lt 8 ]]; then
  password=""
  if [[ -t 0 ]]; then
    read -r -s -p "Choose a password for the app's pages (8+ characters; leave blank to make one up): " password
    echo
    if [[ -n $password && ( ${#password} -lt 8 || $password == *"'"* ) ]]; then
      echo "setup: passwords need 8+ characters and no ' — one was made up instead." >&2
      password=""
    fi
  fi
  if [[ -z $password ]]; then
    put ADMIN_PASSWORD "$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)"
    echo "setup: made ADMIN_PASSWORD — see it with: grep ADMIN_PASSWORD .env"
  else
    # Single-quoted, so Compose takes $, # and spaces in it literally.
    put ADMIN_PASSWORD "'$password'"
    echo "setup: saved your ADMIN_PASSWORD"
  fi
  changed=1
fi

if (( changed )); then
  echo "setup: done. Start (or update) the app with: docker compose up -d --build"
else
  echo "setup: .env already has everything it needs."
fi
