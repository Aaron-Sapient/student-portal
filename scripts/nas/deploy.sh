#!/bin/bash
# Deploy the scorer to the NAS `score-cron` container dir. The repo is NOT
# synced to the NAS (the dev-mirror Syncthing share was torn down 2026-06-08),
# so script/rubric changes made on the Mac must be pushed with this after edit.
# Secrets note: .env.local is hand-carried over SSH on purpose — Syncthing
# never syncs env files (see .stignore).
set -euo pipefail
KEY=~/.claude/secrets/qnap-nas/qnap_coach
# MagicDNS (NAS runs Tailscale directly since 6/05) — works from any network;
# the old LAN IP (192.168.1.34) broke on any other 192.168.1.x wifi.
DEST=blumenfox@qnappy.tail4ab0a5.ts.net:/share/Container/score-cron/app/
HERE="$(cd "$(dirname "$0")" && pwd)"

scp -i "$KEY" "$HERE/scoreStudents.cjs" "$HERE/scoring-rubric.md" "$DEST"
if [[ "${1:-}" == "--with-env" ]]; then
  scp -i "$KEY" "$HERE/../../.env.local" "$DEST"
fi
echo "Deployed. The container picks changes up on its next run (files are bind-mounted)."
