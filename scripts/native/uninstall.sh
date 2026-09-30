#!/usr/bin/env bash
#
# Stop Wish Calendar on this Mac and remove its launchd agents. The data —
# the database and the WhatsApp link, in ~/Library/Application Support/
# WishCalendar — and the logs stay; install.sh starts it again as it was.
#
#   bash scripts/native/uninstall.sh

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

for part in app whatsapp; do
  if launchctl bootout "$GUI/$LABEL_PREFIX.$part" 2>/dev/null; then say "stopped $part"; fi
  rm -f "${AGENTS_DIR:?}/${LABEL_PREFIX:?}.${part:?}.plist"
done
say "removed. The data stays in $SUPPORT_DIR"
