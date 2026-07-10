/**
 * reconcile.cjs — Sheets → Supabase reconciliation cron (Step C).
 *
 *   node scripts/reconcile.cjs              # full reconcile (roster + params + scores)
 *   node scripts/reconcile.cjs --fast       # roster + params only (2 cheap reads; skip the 40-read scores pass)
 *   node scripts/reconcile.cjs --dry        # run each step in DRY mode (no writes)
 *
 * Suggested cadence: `--fast` every ~10 min (roster/params change rarely but are
 * cheap), full every ~hour or after the weekly NAS scorer (scores change weekly,
 * and the per-student pass is the only heavy part).
 *
 * Keeps Supabase fresh from the authoritative Google Sheets for the domains whose
 * read flags are BUILT (scores, score_params, roster/identity), so those flags can
 * safely go to `on`. Every step is LIVE-SAFE (upsert / soft-deactivate — no
 * delete-all window) and idempotent, so it's safe to run on a schedule while the
 * app reads Supabase.
 *
 * Deploy: a NAS cron (the same host that runs scoreStudents.cjs), e.g. every
 * 10–15 min: `cd <repo> && node scripts/reconcile.cjs >> reconcile.log 2>&1`.
 * Requires .env.local present in the repo (the child scripts read it). A lockfile
 * prevents overlapping runs. Mac↔NAS deploy is Aaron's call.
 *
 * NOTE — scope: covers the built-flag domains. Wave 1 added checkins,
 * instructor_blocks, transcript, college lists, and comps; Wave 3 added
 * parent_checkins (best-effort app dual-write in lib/parentCheckinCore.js +
 * this upsert backstop). All live-safe (upsert / insert-missing+prune-by-key,
 * never delete-then-insert). Still NOT reconciled here: written_reports (its
 * reads need the app dual-write first); meetings_log is being retired in favor
 * of the `meetings` hub table (kept fresh by the student-hub step).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DRY = process.argv.includes('--dry');
const FAST = process.argv.includes('--fast');
const SCRIPTS = __dirname;
const LOCK = path.join(os.tmpdir(), 'student-portal-reconcile.lock');
const STALE_MS = 20 * 60 * 1000; // a run older than this is assumed dead → override

const ALL_STEPS = [
  // ---- fast tier (cheap Master-tab reads; run in --fast every ~10 min) ----
  { name: 'roster (students + guardians + gender + soft-deactivate)', script: 'backfillStudents.cjs', args: ['--reconcile'] },
  { name: 'score_params', script: 'backfillScoreParams.cjs', args: [] },
  { name: 'checkins (live-safe upsert)', script: 'backfillCheckins.cjs', args: ['--reconcile'] },
  { name: 'instructor_blocks (live-safe insert-missing/update/prune)', script: 'reconcileInstructorBlocks.cjs', args: [] },
  { name: 'parent_checkins (live-safe upsert on natural key)', script: 'backfillParentCheckins.cjs', args: [] },
  // ---- heavy tier (per-student fan-out; full hourly pass only) ----
  { name: 'scores (live-safe upsert + prune)', script: 'reconcileScores.cjs', args: [], heavy: true },
  // Students-tab hub mirror (intended major + 📆 Meetings agenda). Heavy
  // per-student fan-out; read-only one-way (never writes the sheet). Requires
  // supabase/students_hub_schema.sql applied first, or its upserts fail this step
  // (other steps still run). See scripts/mirrorStudentHub.cjs.
  { name: 'student hub (profiles + overview + grade + meetings)', script: 'mirrorStudentHub.cjs', args: [], heavy: true },
  { name: 'transcript (live-safe upsert + prune)', script: 'reconcileTranscript.cjs', args: [], heavy: true },
  { name: 'college lists (jsonb mirror)', script: 'mirrorCollegeLists.cjs', args: ['--all'], heavy: true },
  { name: 'comps (per-student 🏆 Comps & Projects mirror)', script: 'mirrorComps.cjs', args: [], heavy: true },
];
// --fast skips the heavy per-student passes (just the cheap Master-tab reconciles).
const STEPS = FAST ? ALL_STEPS.filter((s) => !s.heavy) : ALL_STEPS;

function acquireLock() {
  try {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < STALE_MS) return false; // a fresh run holds it
    console.warn(`[reconcile] stale lock (${Math.round((Date.now() - st.mtimeMs) / 60000)}m old) — overriding.`);
  } catch {
    /* no lock — fall through */
  }
  fs.writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}\n`);
  return true;
}

function run() {
  // Stamp start time without Date.now()-in-prompt concerns; this is a plain script.
  const started = Date.now();
  const results = [];
  for (const step of STEPS) {
    const args = [path.join(SCRIPTS, step.script), ...step.args, ...(DRY ? [] : ['--write'])];
    console.log(`\n[reconcile] ▶ ${step.name}${DRY ? ' (dry)' : ''}`);
    const r = spawnSync('node', args, { cwd: path.join(SCRIPTS, '..'), stdio: 'inherit' });
    results.push({ name: step.name, ok: r.status === 0, code: r.status });
  }

  const failed = results.filter((r) => !r.ok);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n[reconcile] done in ${secs}s — ${results.length - failed.length}/${results.length} ok.`);
  results.forEach((r) => console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` (exit ${r.code})`}`));
  if (failed.length) process.exitCode = 1;
}

if (!acquireLock()) {
  console.log('[reconcile] another run is in progress — skipping.');
  process.exit(0);
}
try {
  run();
} finally {
  try {
    fs.unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
}
