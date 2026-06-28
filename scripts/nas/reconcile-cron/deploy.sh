#!/bin/bash
# Deploy / redeploy the Sheets→Supabase reconcile cron to the NAS `reconcile-cron`
# container. Mirrors scripts/nas/deploy.sh (the scorer). The repo is NOT synced to the
# NAS, so push script/Dockerfile changes with this after editing.
#
#   ./deploy.sh                # push scripts + Dockerfile, rebuild image, (re)start container
#   ./deploy.sh --with-env     # also hand-carry .env.local (Supabase + Google creds)
#
# Secrets note: .env.local is hand-carried over SSH on purpose (Syncthing never syncs env
# files). It includes SUPABASE_SERVICE_ROLE_KEY — lands in a chmod-600 container dir only.
set -euo pipefail
KEY=~/.claude/secrets/qnap-nas/qnap_coach
HOST=blumenfox@qnappy.tail4ab0a5.ts.net   # MagicDNS (NAS runs Tailscale directly) — any network
BASE=/share/Container/reconcile-cron
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
DOCKER='/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker'
DENV='export HOME=/share/Container/coach DOCKER_CONFIG=/share/Container/coach/.docker'

ssh -i "$KEY" "$HOST" "mkdir -p $BASE/app/scripts $BASE/app/lib $BASE/logs"
# Every script named in reconcile.cjs's ALL_STEPS must be hand-carried (the repo is NOT
# synced to the NAS). Wave 1 added checkins, instructor_blocks, student-hub, transcript,
# college lists, and comps to the prior roster/params/scores set.
scp -i "$KEY" \
  "$REPO/scripts/reconcile.cjs" \
  "$REPO/scripts/backfillStudents.cjs" \
  "$REPO/scripts/backfillScoreParams.cjs" \
  "$REPO/scripts/backfillCheckins.cjs" \
  "$REPO/scripts/reconcileInstructorBlocks.cjs" \
  "$REPO/scripts/reconcileScores.cjs" \
  "$REPO/scripts/mirrorStudentHub.cjs" \
  "$REPO/scripts/reconcileTranscript.cjs" \
  "$REPO/scripts/mirrorCollegeLists.cjs" \
  "$REPO/scripts/mirrorComps.cjs" \
  "$HOST:$BASE/app/scripts/"
# mirrorCollegeLists.cjs dynamic-imports lib/collegeList.js (ESM), which statically imports
# lib/supabase.js + lib/readFlags.js. They must live at $BASE/app/lib so the script's
# `../lib/...` resolves. (The Dockerfile symlinks /node_modules → the global install so the
# ESM resolver — which, unlike CJS require(), ignores NODE_PATH — still finds luxon/supabase.)
scp -i "$KEY" \
  "$REPO/lib/collegeList.js" \
  "$REPO/lib/supabase.js" \
  "$REPO/lib/readFlags.js" \
  "$HOST:$BASE/app/lib/"
scp -i "$KEY" "$HERE/Dockerfile" "$HOST:$BASE/Dockerfile"
if [[ "${1:-}" == "--with-env" ]]; then
  scp -i "$KEY" "$REPO/.env.local" "$HOST:$BASE/app/.env.local"
  ssh -i "$KEY" "$HOST" "chmod 600 $BASE/app/.env.local"
fi

ssh -i "$KEY" "$HOST" "$DENV; cd $BASE \
  && $DOCKER build -t reconcile-cron:latest . \
  && $DOCKER rm -f reconcile-cron 2>/dev/null || true; \
  $DENV; $DOCKER run -d --name reconcile-cron --restart unless-stopped \
    -v $BASE/app:/app -v $BASE/logs:/logs reconcile-cron:latest"
echo "Deployed reconcile-cron. Logs: $BASE/logs/reconcile.log"
