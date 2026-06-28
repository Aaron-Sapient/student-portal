/**
 * mirrorComps.cjs — LIVE-SAFE per-student 🏆 Comps & Projects mirror (Sheets → Supabase).
 *
 *   node scripts/mirrorComps.cjs                 # DRY RUN (read + report, no write)
 *   node scripts/mirrorComps.cjs --write         # upsert student_comps (live-safe)
 *   node scripts/mirrorComps.cjs --limit 1       # first student only (quick check)
 *   node scripts/mirrorComps.cjs <SHEET_ID>      # one student (spot check)
 *
 * Mirrors every DATA row of each ACTIVE student's '🏆 Comps & Projects'!E:N block
 * (one row per phase) verbatim into the `student_comps` table, so the home-data /
 * parent home-data project cards and the report / check-in prompt builders can read
 * Supabase instead of Sheets once READ_SUPABASE_COMPS flips on. One Sheets read per
 * student (E:N, UNFORMATTED_VALUE) with quotaUser pacing; read-only against Google.
 *
 * LIVE-SAFE: UPSERTS on (student_sheet_id, seq) — never delete-then-insert — then
 * prunes only TRAILING orphan rows for students it SUCCESSFULLY read this run (a
 * student whose phase list shrank). A student skipped on a read error is never
 * pruned. Idempotent, so it's safe on the reconcile cron while the app reads Supabase.
 *
 * Column map (E:N, UNFORMATTED_VALUE): E=name(0) F=start(1) G=end(2) H=deadline(3)
 * I=progress(4) J=bar(5,unused) K=status(6) L=details(7) M=link(8) N=owner(9).
 * Dates → LA calendar date (replicates lib/projects.js toLADate). progress kept as
 * the raw 0..1 fraction (float8 so PostgREST returns a JS number). Text cells stored
 * VERBATIM (NO trim): the trailing space on col E is the write-back key, and status /
 * owner are compared with strict === downstream, so trimming would flip parity.
 *
 * Requires the student_comps table applied + .env.local present. Deploy: a heavy
 * step of the reconcile cron (see scripts/reconcile.cjs). Reads the active-student
 * list from the `students` table (same source as mirrorStudentHub / reconcileScores).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const ZONE = 'America/Los_Angeles';
const PROJECTS_RANGE = "'🏆 Comps & Projects'!E:N";
const QUOTA_USER = 'mirror-comps';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Text cell stored VERBATIM (no trim — trailing spaces are load-bearing for the
// col-E write-back key and the strict-=== status/owner gates). '' / absent → null.
const verbatim = (v) => (v === undefined || v === null || v === '' ? null : String(v));

// '🏆 Comps & Projects' date cell (UNFORMATTED_VALUE: serial number or string) →
// LA calendar date 'YYYY-MM-DD', or null. Replicates lib/projects.js toLADate so the
// mirrored ISO date renders byte-identically to the Sheets serial path downstream.
function toISODate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    const utc = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000), { zone: 'utc' });
    if (!utc.isValid) return null;
    return DateTime.fromObject({ year: utc.year, month: utc.month, day: utc.day }, { zone: ZONE }).toISODate();
  }
  const dt = DateTime.fromISO(String(raw), { zone: ZONE });
  return dt.isValid ? dt.toISODate() : null;
}

// col I → the raw 0..1 fraction as a JS number, or null when blank / non-numeric.
function toProgress(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Build the student_comps rows for one student's E:N values. Slices the header
// (sheet row 1) and mirrors every row with ANY non-empty E:N cell, assigning
// seq = 0-based ordinal among mirrored rows (the stable upsert/prune + display key).
// Blank rows are skipped — all consumers filter them out anyway (no status/activity).
function compRowsFor(studentSheetId, values) {
  const out = [];
  let seq = 0;
  for (const r of (values || []).slice(1)) {
    const c = r || [];
    const hasContent = c.some((cell) => cell !== '' && cell !== null && cell !== undefined);
    if (!hasContent) continue;
    out.push({
      student_sheet_id: studentSheetId,
      seq: seq++,
      name: verbatim(c[0]),
      start_date: toISODate(c[1]),
      end_date: toISODate(c[2]),
      deadline: toISODate(c[3]),
      progress: toProgress(c[4]),
      status: verbatim(c[6]),
      details: verbatim(c[7]),
      link: verbatim(c[8]),
      owner: verbatim(c[9]),
      project_id: null,
    });
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const WRITE = argv.includes('--write');
  const limIdx = argv.indexOf('--limit');
  const LIMIT = limIdx >= 0 ? Number(argv[limIdx + 1]) : Infinity;
  // First positional (not a flag, not the --limit value) = single-student spot check.
  const ONLY = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--limit')[0];

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

  const { data: roster, error } = await sb
    .from('students')
    .select('student_sheet_id, name')
    .eq('status', 'active')
    .order('name');
  if (error) throw error;
  const students = ONLY ? roster.filter((s) => s.student_sheet_id === ONLY) : roster;

  const allComps = [];
  const readIds = new Set();
  let withRows = 0;
  let processed = 0;

  for (const s of students) {
    if (processed >= LIMIT) break;
    processed++;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: s.student_sheet_id,
        range: PROJECTS_RANGE,
        valueRenderOption: 'UNFORMATTED_VALUE',
        quotaUser: QUOTA_USER,
      });
      const comps = compRowsFor(s.student_sheet_id, res.data.values || []);
      allComps.push(...comps);
      if (comps.length) withRows++;
      readIds.add(s.student_sheet_id);
    } catch (e) {
      // No 🏆 Comps & Projects tab or a transient failure — do NOT prune this one.
      console.warn(`  skip ${s.name} (${s.student_sheet_id}): ${e.message}`);
    }
    await sleep(60); // gentle pacing under the per-project quota ceiling
  }

  console.log(
    `Read ${readIds.size}/${Math.min(students.length, LIMIT)} students · ` +
      `${withRows} with comps rows · ${allComps.length} comp rows total.`
  );
  if (!WRITE) {
    console.log('DRY RUN — re-run with --write to upsert.');
    if (allComps.length) console.log('  sample row:', JSON.stringify(allComps[0]));
    return;
  }

  // ── student_comps: upsert on (student_sheet_id, seq) (no delete window) ──────
  for (let i = 0; i < allComps.length; i += 500) {
    const { error: uErr } = await sb
      .from('student_comps')
      .upsert(allComps.slice(i, i + 500), { onConflict: 'student_sheet_id,seq' });
    if (uErr) {
      console.error('student_comps upsert failed:', uErr.message);
      process.exit(1);
    }
  }
  console.log(`✓ Upserted ${allComps.length} student_comps row(s) (live-safe, no delete window).`);

  // Prune trailing rows (a student whose phase list shrank): only for students read
  // this run, only seqs not present now. Current rows were upserted first, so the
  // live comps list is always complete during the prune.
  const currentKeys = new Set(allComps.map((c) => `${c.student_sheet_id}|${c.seq}`));
  const { data: existing, error: exErr } = await sb
    .from('student_comps')
    .select('id, student_sheet_id, seq');
  if (exErr) {
    console.error('student_comps prune-read failed:', exErr.message);
    process.exit(1);
  }
  const orphanIds = (existing || [])
    .filter((r) => readIds.has(r.student_sheet_id) && !currentKeys.has(`${r.student_sheet_id}|${r.seq}`))
    .map((r) => r.id);
  if (orphanIds.length) {
    for (let i = 0; i < orphanIds.length; i += 500) {
      const { error: dErr } = await sb.from('student_comps').delete().in('id', orphanIds.slice(i, i + 500));
      if (dErr) {
        console.error('student_comps prune failed:', dErr.message);
        process.exit(1);
      }
    }
    console.log(`✓ Pruned ${orphanIds.length} stale student_comps row(s).`);
  } else {
    console.log('✓ No stale student_comps rows to prune.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
