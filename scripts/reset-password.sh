#!/usr/bin/env bash
#
# Forgot the password? This removes the one set on the Settings page, so the
# first one — ADMIN_PASSWORD in .env — works again. Run it on the computer
# that runs the app, from the project folder:
#
#   bash scripts/reset-password.sh
#
# Everyone is signed out. Sign in with ADMIN_PASSWORD (see it with
# grep ADMIN_PASSWORD .env), then set a new one in Settings → Password.
# The page itself offers no reset: whoever can reach it cannot use one.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

app_node '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.env.DATA_DIR + "/birthdays.db");
  const { changes } = db.prepare("DELETE FROM settings WHERE key = ?").run("password_hash");
  console.log(changes
    ? "reset-password: the password set in Settings is removed, and everyone is signed out."
    : "reset-password: no password was set in Settings — the one in .env already applies.");
'
say "sign in with ADMIN_PASSWORD from .env — see it with: grep ADMIN_PASSWORD .env"
