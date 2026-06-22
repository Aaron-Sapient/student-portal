# reconcile-cron — Sheets→Supabase reconciliation runner (see app/scripts/reconcile.cjs).
# Mirrors the score-cron container pattern (cron baked into the image, bind-mounted
# /app + /logs). Keeps Supabase fresh for the BUILT read-flag domains (scores,
# score_params, roster) so those flags can safely go `on`. Every step the cron runs is
# live-safe (upsert / soft-deactivate — no delete window) and lockfile-guarded.
# NOTE: node:24 (not 20 like score-cron). @supabase/supabase-js's realtime client needs
# native WebSocket (Node >=22; Node 20 throws at createClient). 24 is the current LTS and
# matches Aaron's Mac (Node 24) — the env these scripts are verified on. (Not "latest":
# unattended cron wants the newest *LTS*, not a short-lived odd/current release.)
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends cron tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/share/zoneinfo/America/Los_Angeles /etc/localtime && echo America/Los_Angeles > /etc/timezone
# Deps are global (the scripts require() them via NODE_PATH); no package.json/node_modules mount.
RUN npm install -g googleapis @supabase/supabase-js luxon && npm cache clean --force
ENV NODE_PATH=/usr/local/lib/node_modules TZ=America/Los_Angeles
# --fast (roster + score_params, 2 cheap Master reads) every 10 min; full reconcile
# (adds the heavy ~40-read scores pass) hourly at :05. The lockfile in reconcile.cjs
# skips overlapping runs. Scripts read creds from /app/.env.local (a FILE, not env),
# so cron's minimal environment is fine.
RUN ( \
      echo "*/10 * * * * cd /app && PATH=/usr/local/bin:/usr/bin:/bin NODE_PATH=/usr/local/lib/node_modules node scripts/reconcile.cjs --fast >> /logs/reconcile.log 2>&1"; \
      echo "5 * * * * cd /app && PATH=/usr/local/bin:/usr/bin:/bin NODE_PATH=/usr/local/lib/node_modules node scripts/reconcile.cjs >> /logs/reconcile.log 2>&1" \
    ) | crontab -
CMD ["cron", "-f"]
