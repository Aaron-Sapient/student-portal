/**
 * reconcileScores.cjs — LIVE-SAFE scores sync (Sheets → Supabase `scores`).
 *
 *   node scripts/reconcileScores.cjs            # DRY RUN (read + report, no write)
 *   node scripts/reconcileScores.cjs --write    # upsert
 *
 * Unlike backfillPerStudent.cjs (which delete-all-then-inserts `scores`, briefly
 * emptying the table — fine for a one-time backfill, NOT for a cron that runs
 * while the app may read `scores` in `on` mode), this UPSERTS on the table's
 * unique key (student_sheet_id, scored_date). No delete window ⇒ safe to run on a
 * schedule against a live read path. Weekly scores are effectively append-only, so
 * upsert (no row removal) is the right model; a deleted sheet row is rare and the
 * latest row — what the UI reads — always reflects the sheet.
 *
 * Column mapping mirrors lib/scores.js parseRow + backfillPerStudent (rubric v2):
 *   A date · B academic · C ec · D leadership · E overall · F insight · G coach ·
 *   H rubricVer · I model.  v1 rows ('v1' at G/idx 6): D=overall, E=insight,
 *   F=coach, G='v1', H=model — leadership absent (NULL). RAW values stored.
 * Read-only against Sheets. Idempotent.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const ZONE = 'America/Los_Angeles';
const SCORES_TAB = '📊 Scores';
const QUOTA_USER = 'reconcile-scores';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toNum = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clean = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

function scoreRowsFor(studentSheetId, values) {
  const out = [];
  for (const r of values || []) {
    const dt = DateTime.fromISO(String(r[0] || ''), { zone: ZONE });
    if (!dt.isValid) continue;
    const isV1 = r[6] === 'v1';
    out.push({
      student_sheet_id: studentSheetId,
      scored_date: dt.toISODate(),
      academic: toNum(r[1]),
      ec: toNum(r[2]),
      leadership: isV1 ? null : toNum(r[3]),
      overall: isV1 ? toNum(r[3]) : toNum(r[4]),
      insight: clean(isV1 ? r[4] : r[5]),
      coach_note: clean(isV1 ? r[5] : r[6]),
      rubric_ver: isV1 ? 'v1' : clean(r[7]),
      model: clean(isV1 ? r[7] : r[8]),
    });
  }
  return out;
}

async function main() {
  const WRITE = process.argv.includes('--write');
  const get = loadEnv();
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

  // Only ACTIVE students (NC sheets aren't scored). scores FKs to students, so
  // every student_sheet_id here already exists.
  const { data: students, error } = await sb
    .from('students')
    .select('student_sheet_id, name')
    .eq('status', 'active')
    .order('name');
  if (error) throw error;

  const all = [];
  const readIds = new Set(); // students whose Scores tab we SUCCESSFULLY read
  let missing = 0;
  for (const s of students) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: s.student_sheet_id,
        range: `'${SCORES_TAB}'!A2:I400`,
        quotaUser: QUOTA_USER,
      });
      const rows = scoreRowsFor(s.student_sheet_id, res.data.values || []);
      all.push(...rows);
      readIds.add(s.student_sheet_id);
    } catch {
      missing++; // no Scores tab / transient read failure — do NOT prune this one
    }
    await sleep(60); // gentle pacing under the per-project quota ceiling
  }
  const read = readIds.size;

  // Dedup on the table's unique key (student_sheet_id, scored_date): a sheet may
  // carry two rows for the same date (a same-day re-score). Postgres can't upsert
  // two rows with the same conflict key in one statement, and the column is unique
  // anyway — keep the LAST occurrence (latest edit / correction wins, matching the
  // app's "latest row" semantics).
  const byKey = new Map();
  for (const row of all) byKey.set(`${row.student_sheet_id}|${row.scored_date}`, row);
  const deduped = [...byKey.values()];
  const dupCount = all.length - deduped.length;

  console.log(
    `Read ${read} students (${missing} without a Scores tab); ${all.length} score rows` +
      (dupCount ? ` (${dupCount} same-date duplicate(s) collapsed → ${deduped.length})` : '') +
      '.'
  );
  if (!WRITE) {
    console.log('DRY RUN — re-run with --write to upsert.');
    return;
  }

  // Upsert in chunks on the unique (student_sheet_id, scored_date) — no delete,
  // so the table is never momentarily empty (current rows are always present).
  for (let i = 0; i < deduped.length; i += 500) {
    const { error: uErr } = await sb
      .from('scores')
      .upsert(deduped.slice(i, i + 500), { onConflict: 'student_sheet_id,scored_date' });
    if (uErr) {
      console.error('scores upsert failed:', uErr.message);
      process.exit(1);
    }
  }
  console.log(`✓ Upserted ${deduped.length} score rows (live-safe, no delete window).`);

  // Prune orphans so Supabase is an EXACT mirror: a row deleted / date-changed in
  // a sheet should not linger. SAFETY: only ever prune students we SUCCESSFULLY
  // read this run (readIds) — a transient read failure must never wipe scores. We
  // upserted current rows first, so the live rows are always present; pruning only
  // removes stale extras.
  const currentKeys = new Set(deduped.map((r) => `${r.student_sheet_id}|${r.scored_date}`));
  const { data: existing, error: exErr } = await sb
    .from('scores')
    .select('id, student_sheet_id, scored_date');
  if (exErr) {
    console.error('scores prune-read failed:', exErr.message);
    process.exit(1);
  }
  const orphanIds = (existing || [])
    .filter((r) => readIds.has(r.student_sheet_id) && !currentKeys.has(`${r.student_sheet_id}|${r.scored_date}`))
    .map((r) => r.id);
  if (orphanIds.length) {
    for (let i = 0; i < orphanIds.length; i += 500) {
      const { error: pErr } = await sb.from('scores').delete().in('id', orphanIds.slice(i, i + 500));
      if (pErr) {
        console.error('scores prune failed:', pErr.message);
        process.exit(1);
      }
    }
    console.log(`✓ Pruned ${orphanIds.length} orphan score row(s) (gone from their sheet).`);
  } else {
    console.log('✓ No orphan score rows to prune.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
