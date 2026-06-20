/**
 * shadowCompareRoster.cjs — parity check for the ROSTER/IDENTITY read cutover.
 *
 *   node scripts/shadowCompareRoster.cjs
 *
 * Identity is auth-critical (it decides whose data an email may see), so this
 * verifies the DATA that drives classifyEmail rather than re-implementing it:
 *   • student map: email (Master col J) → sheetId (col G), active rows only
 *   • parent map:  email (col K / L)   → set of child sheetIds, active rows only
 * and the Supabase equivalents (students / guardians, status='active'). If both
 * maps match, classifyEmail's student-wins resolution matches by construction.
 * Read-only against both systems.
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

const normEmail = (v) => String(v ?? '').trim().toLowerCase();
const isNC = (r) => String(r?.[1] ?? '').trim().toUpperCase() === 'NC';
const sheetIdFromPortalUrl = (url) => {
  const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
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

  // ── Sheets maps ──────────────────────────────────────────────────────────
  const rows =
    (await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${MASTER_TAB}!A:BD` }))
      .data.values || [];
  const sheetStudent = new Map(); // email -> sheetId (null if portal url unparseable)
  const sheetParent = new Map(); // email -> Set(sheetId)
  for (const r of rows) {
    if (isNC(r)) continue;
    const sid = sheetIdFromPortalUrl(r?.[6]);
    const sEmail = normEmail(r?.[9]);
    if (sEmail.includes('@')) sheetStudent.set(sEmail, sid);
    for (const idx of [10, 11]) {
      const pEmail = normEmail(r?.[idx]);
      if (pEmail.includes('@') && sid) {
        if (!sheetParent.has(pEmail)) sheetParent.set(pEmail, new Set());
        sheetParent.get(pEmail).add(sid);
      }
    }
  }

  // ── Supabase maps ────────────────────────────────────────────────────────
  const { data: studs } = await sb
    .from('students')
    .select('student_sheet_id, student_email, status')
    .eq('status', 'active');
  const supaStudent = new Map();
  for (const s of studs) if (s.student_email) supaStudent.set(normEmail(s.student_email), s.student_sheet_id);

  const { data: guards } = await sb
    .from('guardians')
    .select('email, student_sheet_id, students(status)');
  const supaParent = new Map();
  for (const g of guards) {
    if (!g.students || g.students.status !== 'active') continue;
    const e = normEmail(g.email);
    if (!supaParent.has(e)) supaParent.set(e, new Set());
    supaParent.get(e).add(g.student_sheet_id);
  }

  // ── Compare ──────────────────────────────────────────────────────────────
  const studentDiffs = [];
  for (const e of new Set([...sheetStudent.keys(), ...supaStudent.keys()])) {
    const a = sheetStudent.get(e);
    const b = supaStudent.get(e);
    if (a !== b) studentDiffs.push(`${e}: sheets=${a ?? '∅'} supa=${b ?? '∅'}`);
  }

  const setEq = (x, y) => x && y && x.size === y.size && [...x].every((v) => y.has(v));
  const parentDiffs = [];
  for (const e of new Set([...sheetParent.keys(), ...supaParent.keys()])) {
    const a = sheetParent.get(e);
    const b = supaParent.get(e);
    if (!setEq(a, b)) {
      parentDiffs.push(`${e}: sheets=[${a ? [...a].join(',') : '∅'}] supa=[${b ? [...b].join(',') : '∅'}]`);
    }
  }

  console.log('\n── ROSTER/IDENTITY shadow parity ──');
  console.log(`student emails: sheets=${sheetStudent.size} supa=${supaStudent.size} · mismatches=${studentDiffs.length}`);
  console.log(`parent emails:  sheets=${sheetParent.size} supa=${supaParent.size} · mismatches=${parentDiffs.length}`);
  if (studentDiffs.length) {
    console.log('\nStudent map mismatches:');
    studentDiffs.forEach((d) => console.log(`  ✗ ${d}`));
  }
  if (parentDiffs.length) {
    console.log('\nParent map mismatches:');
    parentDiffs.forEach((d) => console.log(`  ✗ ${d}`));
  }
  if (!studentDiffs.length && !parentDiffs.length) {
    console.log('\n✓ Full parity — every student and parent email resolves identically.');
  } else {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
