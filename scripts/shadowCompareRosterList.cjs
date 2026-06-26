/**
 * shadowCompareRosterList.cjs — parity check for the ROSTER-LIST read cutover.
 *
 *   node scripts/shadowCompareRosterList.cjs
 *
 * The dev surfaces (Scoring spot-check, Students cards, Writing picker) read the
 * WHOLE roster as { name, grade, classYear, sheetId } via lib/identity.listStudents
 * — a list, not the email→identity lookup shadowCompareRoster.cjs already covers.
 * This verifies the two sources that reader switches between agree, value-for-value:
 *   • Sheets:   Master 'A:G' — a row is a student iff it has a name AND a parseable
 *               portal URL (col G). NC rows are NOT filtered (listRoster never did).
 *   • Supabase: the `students` mirror (student_sheet_id IS the portal sheetId).
 * Read-only against both systems. Mirrors lib/identity's parse exactly.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = "'👩‍🎓 All Data'";

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

const sheetIdFromPortalUrl = (url) => {
  const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
};
const classYearFromClass = (klass) => {
  const m = String(klass ?? '').match(/(\d{2})\s*$/);
  return m ? 2000 + Number(m[1]) : null;
};

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

  // ── Sheets list (mirrors listStudentsFromSheets: A:G, name + parseable portal) ──
  const rows =
    (await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${MASTER_TAB}!A:G` }))
      .data.values || [];
  const sheetList = new Map(); // sheetId -> { name, grade, classYear }
  for (const r of rows.slice(1)) {
    const name = String(r?.[0] ?? '').trim();
    const sheetId = sheetIdFromPortalUrl(r?.[6]);
    if (!name || !sheetId) continue;
    const klass = String(r?.[1] ?? '').trim();
    sheetList.set(sheetId, { name, grade: klass, classYear: classYearFromClass(klass) });
  }

  // ── Supabase list (mirrors listStudentsFromSupabase: NC → "NC" from status) ──
  const { data: studs, error } = await sb.from('students').select('student_sheet_id, name, class, status');
  if (error) throw error;
  const supaList = new Map();
  for (const s of studs || []) {
    const name = String(s.name ?? '').trim();
    if (!name || !s.student_sheet_id) continue;
    const klass = s.status === 'nc' ? 'NC' : String(s.class ?? '').trim();
    supaList.set(s.student_sheet_id, { name, grade: klass, classYear: classYearFromClass(klass) });
  }

  // ── Compare ──────────────────────────────────────────────────────────────
  const diffs = [];
  for (const id of sheetList.keys()) if (!supaList.has(id)) diffs.push(`supa MISSING ${id} (${sheetList.get(id).name})`);
  for (const id of supaList.keys()) if (!sheetList.has(id)) diffs.push(`supa EXTRA ${id} (${supaList.get(id).name})`);
  for (const [id, a] of sheetList) {
    const b = supaList.get(id);
    if (!b) continue;
    if (a.name !== b.name) diffs.push(`name@${id} "${a.name}"≠"${b.name}"`);
    if (a.grade !== b.grade) diffs.push(`grade@${id} "${a.grade}"≠"${b.grade}"`);
    if (a.classYear !== b.classYear) diffs.push(`classYear@${id} ${a.classYear}≠${b.classYear}`);
  }

  console.log('\n── ROSTER-LIST shadow parity ──');
  console.log(`students: sheets=${sheetList.size} supa=${supaList.size} · mismatches=${diffs.length}`);
  if (diffs.length) {
    console.log('\nMismatches:');
    diffs.forEach((d) => console.log(`  ✗ ${d}`));
    process.exitCode = 1;
  } else {
    console.log('\n✓ Full parity — every student lists identically (name · grade · classYear · sheetId).');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
