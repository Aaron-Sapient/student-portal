/**
 * reconcileTranscript.cjs — LIVE-SAFE transcript sync (Sheets → `transcript_entries`).
 *
 *   node scripts/reconcileTranscript.cjs            # DRY RUN (read + report, no write)
 *   node scripts/reconcileTranscript.cjs --write    # upsert + prune
 *
 * Unlike backfillPerStudent.cjs (which delete-all-then-inserts transcript_entries,
 * briefly emptying the table — fine for a one-time backfill, NOT for a cron that may
 * run while READ_SUPABASE_TRANSCRIPT=on), this UPSERTS on the table's unique key
 * (student_sheet_id, grade_level, ordinal) — no delete window — then prunes orphans
 * ONLY for students it successfully read this run (a transient read failure must
 * never wipe a student's transcript). Idempotent, read-only against Sheets.
 *
 * Parser (TBLOCKS / parseTranscript) is COPIED verbatim from backfillPerStudent.cjs
 * so the reconciled rows are byte-identical to the existing backfill.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const TRANSCRIPT_RANGE = "'🎓 Transcript'!A1:V40";
const QUOTA_USER = 'reconcile-transcript';

// 4-quadrant transcript grid (mirrors backfillPerStudent.cjs + lib/gradeData SLOT_GEOMETRY)
const TBLOCKS = [
  { grade: 9, lo: 6, hi: 15, cls: 4, wt: 5, ap: 6, s1: 7, s2: 10 },
  { grade: 10, lo: 24, hi: 33, cls: 4, wt: 5, ap: 6, s1: 7, s2: 10 },
  { grade: 11, lo: 6, hi: 15, cls: 15, wt: 16, ap: 17, s1: 18, s2: 21 },
  { grade: 12, lo: 24, hi: 33, cls: 15, wt: 16, ap: 17, s1: 18, s2: 21 },
];

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = (v) => { const s = String(v ?? '').trim(); return s || null; };
const bool = (v) => v === true || String(v ?? '').trim().toUpperCase() === 'TRUE';

function transcriptRowsFor(studentSheetId, rows) {
  const out = [];
  for (const b of TBLOCKS) {
    let ord = 0;
    for (let row = b.lo; row <= b.hi; row++) {
      const r = rows?.[row - 1] || [];
      const course = t(r[b.cls]);
      if (!course) continue;
      out.push({
        student_sheet_id: studentSheetId,
        grade_level: b.grade,
        ordinal: ord++,
        course,
        weighted: bool(r[b.wt]),
        is_ap: bool(r[b.ap]),
        sem1_grade: t(r[b.s1]),
        sem2_grade: t(r[b.s2]),
      });
    }
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

  // transcript_entries FKs students; only ACTIVE students have a transcript worth syncing.
  const { data: students, error } = await sb
    .from('students')
    .select('student_sheet_id, name')
    .eq('status', 'active')
    .order('name');
  if (error) throw error;

  const all = [];
  const readIds = new Set();
  let missing = 0;
  for (const s of students) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: s.student_sheet_id,
        range: TRANSCRIPT_RANGE,
        quotaUser: QUOTA_USER,
      });
      all.push(...transcriptRowsFor(s.student_sheet_id, res.data.values || []));
      readIds.add(s.student_sheet_id);
    } catch {
      missing++; // no Transcript tab / transient read failure — do NOT prune this one
    }
    await sleep(60); // gentle pacing under the per-project quota ceiling
  }

  console.log(`Read ${readIds.size} students (${missing} without a readable Transcript tab); ${all.length} transcript rows.`);
  if (!WRITE) {
    console.log('DRY RUN — re-run with --write to upsert.');
    return;
  }

  for (let i = 0; i < all.length; i += 500) {
    const { error: uErr } = await sb
      .from('transcript_entries')
      .upsert(all.slice(i, i + 500), { onConflict: 'student_sheet_id,grade_level,ordinal' });
    if (uErr) {
      console.error('transcript upsert failed:', uErr.message);
      process.exit(1);
    }
  }
  console.log(`✓ Upserted ${all.length} transcript rows (live-safe, no delete window).`);

  // Prune orphans (course removed / grade-block shortened) — ONLY for students read
  // this run. Current rows were upserted first, so live rows are always present.
  const currentKeys = new Set(all.map((r) => `${r.student_sheet_id}|${r.grade_level}|${r.ordinal}`));
  const { data: existing, error: exErr } = await sb
    .from('transcript_entries')
    .select('id, student_sheet_id, grade_level, ordinal');
  if (exErr) {
    console.error('transcript prune-read failed:', exErr.message);
    process.exit(1);
  }
  const orphanIds = (existing || [])
    .filter((r) => readIds.has(r.student_sheet_id) && !currentKeys.has(`${r.student_sheet_id}|${r.grade_level}|${r.ordinal}`))
    .map((r) => r.id);
  if (orphanIds.length) {
    for (let i = 0; i < orphanIds.length; i += 500) {
      const { error: pErr } = await sb.from('transcript_entries').delete().in('id', orphanIds.slice(i, i + 500));
      if (pErr) {
        console.error('transcript prune failed:', pErr.message);
        process.exit(1);
      }
    }
    console.log(`✓ Pruned ${orphanIds.length} orphan transcript row(s).`);
  } else {
    console.log('✓ No orphan transcript rows to prune.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
