/**
 * shadowCompareScores.cjs — parity check for the SCORES read cutover (Step B).
 *
 *   node scripts/shadowCompareScores.cjs
 *
 * For every student it reads the authoritative Sheets '📊 Scores' tab AND the
 * Supabase `scores` table and compares the RAW values (date + academic/ec/
 * leadership/overall), applying the SAME v1/v2 normalization the app uses.
 *
 * Why raw, not curved: both app readers (getStudentScoresFrom{Sheets,Supabase})
 * funnel raw values through the exact same shared curveEntry(), so if the raw
 * inputs match, every displayed/curved number matches by construction. This
 * isolates the only thing the cutover can actually break: did the backfill copy
 * the values faithfully? Read-only against both systems.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const ZONE = 'America/Los_Angeles';
const SCORES_TAB = '📊 Scores';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

// Mirror lib/scores.js `num`: explicit null/undefined → null; '' falls to 0.
const num = (v) => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
};
const key = (v) => String(num(v)); // 'null' | '73' …

// raw record per row, comparable across both sources.
const recKey = (r) => `${key(r.academic)}|${key(r.ec)}|${key(r.leadership)}|${key(r.overall)}`;

function sheetRows(values) {
  const out = new Map(); // isoDate -> rec
  for (const r of values || []) {
    const dt = DateTime.fromISO(String(r[0] || ''), { zone: ZONE });
    if (!dt.isValid) continue;
    const isV1 = r[6] === 'v1';
    out.set(dt.toISODate(), {
      academic: r[1],
      ec: r[2],
      leadership: isV1 ? null : r[3],
      overall: isV1 ? r[3] : r[4],
    });
  }
  return out;
}

function supaRows(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const dt = DateTime.fromISO(String(row.scored_date || ''), { zone: ZONE });
    if (!dt.isValid) continue;
    out.set(dt.toISODate(), {
      academic: row.academic,
      ec: row.ec,
      leadership: row.leadership,
      overall: row.overall,
    });
  }
  return out;
}

async function main() {
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

  const { data: students, error: sErr } = await sb
    .from('students')
    .select('student_sheet_id, name, status')
    .order('name');
  if (sErr) throw sErr;

  const { data: allScores, error: scErr } = await sb
    .from('scores')
    .select('student_sheet_id, scored_date, academic, ec, leadership, overall');
  if (scErr) throw scErr;

  const byStudent = new Map();
  for (const row of allScores) {
    if (!byStudent.has(row.student_sheet_id)) byStudent.set(row.student_sheet_id, []);
    byStudent.get(row.student_sheet_id).push(row);
  }

  let ok = 0;
  let mismatch = 0;
  let bothEmpty = 0;
  const problems = [];

  for (const s of students) {
    let sheetVals = [];
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: s.student_sheet_id,
        range: `'${SCORES_TAB}'!A2:I400`,
      });
      sheetVals = res.data.values || [];
    } catch {
      sheetVals = []; // no Scores tab
    }
    const sheetMap = sheetRows(sheetVals);
    const supaMap = supaRows(byStudent.get(s.student_sheet_id) || []);

    if (sheetMap.size === 0 && supaMap.size === 0) {
      bothEmpty++;
      continue;
    }

    const diffs = [];
    const dates = new Set([...sheetMap.keys(), ...supaMap.keys()]);
    for (const d of dates) {
      const a = sheetMap.get(d);
      const b = supaMap.get(d);
      if (!a) diffs.push(`${d}: in Supabase, missing in Sheets`);
      else if (!b) diffs.push(`${d}: in Sheets, missing in Supabase`);
      else if (recKey(a) !== recKey(b)) diffs.push(`${d}: ${recKey(a)} (sheet) ≠ ${recKey(b)} (supa)`);
    }

    if (diffs.length) {
      mismatch++;
      problems.push({ name: s.name, id: s.student_sheet_id, diffs });
    } else {
      ok++;
    }
  }

  console.log('\n── SCORES shadow parity (raw values; curve is shared, so raw match ⇒ display match) ──');
  console.log(`students checked: ${students.length}`);
  console.log(`  ✓ match:        ${ok}`);
  console.log(`  ✗ mismatch:     ${mismatch}`);
  console.log(`  · both empty:   ${bothEmpty} (no scores either side)`);
  if (problems.length) {
    console.log('\nMismatches:');
    for (const p of problems) {
      console.log(`\n  ✗ ${p.name} (${p.id})`);
      p.diffs.slice(0, 12).forEach((d) => console.log(`      ${d}`));
      if (p.diffs.length > 12) console.log(`      … +${p.diffs.length - 12} more`);
    }
    process.exitCode = 1;
  } else {
    console.log('\n✓ Full parity — every student\'s raw scores match between Sheets and Supabase.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
