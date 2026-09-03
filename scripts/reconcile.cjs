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
 * NOTE — scope: what remains is transcript, college lists, comps, scores,
 * score_params, the student-hub mirror, and the roster (students + guardians,
 * MINUS its three check-in columns).
 *
 * THE RETIREMENT LEDGER. A domain leaves this list the moment the APP takes sole
 * ownership of its table, because mirroring back from a frozen sheet does not merely
 * waste a read — it OVERWRITES or PRUNES what the app just wrote:
 *   instructor_blocks    2026-08-09  (would prune every app-created block)
 *   booking_tokens       2026-08-19  (would prune every app-created grant)
 *   checkins             2026-09-02  (would re-add dead rows from a frozen tab)
 *   parent_checkins      2026-09-02
 *   written_reports      2026-09-02  (new rows carry no sheet_row to match on)
 *   meeting_cap_summary  2026-09-02  (would undo every cap lift in one cycle)
 *   roster check-in cols 2026-09-02  (needs_checkin / last_ryan_checkin /
 *                                     last_aaron_checkin — would overwrite a real
 *                                     check-in with a frozen cell)
 * Do not restore any of them.
 *
 * ⚠ THIS FILE IS NOT WHAT RUNS. The NAS container reads
 * /share/Container/reconcile-cron/app/scripts/, hand-carried by
 * scripts/nas/reconcile-cron/deploy.sh — "The repo is NOT synced to the NAS."
 * Editing this file changes nothing until that script is run. Retiring a step here
 * and deploying the app WITHOUT running it is the worst of both worlds: the app
 * writes and the old cron keeps reverting.
 *
 * All remaining steps stay live-safe (upsert / insert-missing+prune-by-key, never
 * delete-then-insert).
 * meetings_log is being retired in favor of the `meetings` hub table (kept
 * fresh by the student-hub step).
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
  // checkins step REMOVED 2026-09-02 (zero-google D): the portal INSERTs a
  // submitted check-in straight into `checkins` and stamps its outcome there.
  // The Master CheckinForm / A_CheckinForm tabs are frozen residue, so re-deriving
  // the table from them would keep re-adding dead rows forever.
  // instructor_blocks step REMOVED 2026-08-09: blocks are no longer mirrored from
  // Sheets. The app now owns `instructor_blocks` outright (Supabase is the sole
  // source of truth, written directly by app/api/developer/blocks). Re-adding a
  // Sheets→Supabase reconcile here would PRUNE every app-created block, since
  // none of them exist in the frozen InstructorBlocks tab. Do not restore.
  // parent_checkins step REMOVED 2026-09-02 (zero-google F): lib/parentCheckinCore
  // writes the table directly and no longer appends to the ParentCheckins tab.
  //
  // written_reports step REMOVED 2026-09-02 (zero-google D): lib/generateReport
  // INSERTs the report and the developer panel edits it by uuid. New rows carry no
  // sheet_row at all, so a sheet_row-keyed mirror has nothing to match them on.
  //
  // meeting_cap_summary step REMOVED 2026-09-02 (zero-google B): admin/grantBooking
  // now writes meetings_allowed here as the authority. backfillCheckinSummary
  // upserted the FULL row from ✅ Check-Ins H/I, so leaving it in place would undo
  // every cap lift within ten minutes — Ryan lifts a cap, the student is bookable
  // for one cron cycle, then silently blocked again with no error anywhere.
  //
  // ⚠ KNOWN GAP, accepted with this retirement: meetings_used and the four meeting
  // date columns (last/upcoming × ryan/aaron) now have NO writer. They freeze at
  // their last mirrored values, and developer/checkinCompliance reads them for its
  // meeting-recency half. Closing it needs a portal-native writer derived from the
  // `bookings` ledger (lane C), which does not exist yet. Check-in recency, the
  // other half of that dashboard, is unaffected and stays live.
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
