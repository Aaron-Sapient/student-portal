/**
 * shadowCompareTranscript.cjs — parity check for the TRANSCRIPT grade-gate cutover.
 *
 *   node scripts/shadowCompareTranscript.cjs
 *
 * For every ACTIVE student, computes the data-sufficiency gate {enough, reason,
 * grade} from BOTH sources at the CURRENT nowLA and diffs them:
 *   - Sheets:   hasRecentGrades over '🎓 Transcript'!A1:V40 (today's exact path)
 *   - Supabase: hasRecentGradesWith over transcript_entries (the looksLikeGrade probe)
 * Both feed the SAME decision skeleton (lib/gradeData), so a mismatch can only mean
 * transcript_entries doesn't faithfully reflect the sheet's slot grades. Read-only.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');
const {
  hasRecentGrades,
  hasRecentGradesWith,
  looksLikeGrade,
  TRANSCRIPT_GRADE_RANGE,
} = require('../lib/gradeData');

const ZONE = 'America/Los_Angeles';
const QUOTA_USER = 'shadow-transcript';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const now = DateTime.now().setZone(ZONE);
  const nowLA = { year: now.year, month: now.month };

  const { data: students, error } = await sb
    .from('students')
    .select('student_sheet_id, name, class')
    .eq('status', 'active')
    .order('name');
  if (error) throw error;

  let match = 0;
  let mismatch = 0;
  let unreadable = 0;
  const diffs = [];
  for (const s of students) {
    let sheetGate;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: s.student_sheet_id,
        range: TRANSCRIPT_GRADE_RANGE,
        valueRenderOption: 'UNFORMATTED_VALUE', // match the production reads exactly
        quotaUser: QUOTA_USER,
      });
      sheetGate = hasRecentGrades(res.data.values || [], s.class, nowLA);
    } catch {
      unreadable++;
      await sleep(60);
      continue;
    }

    const { data: entries, error: eErr } = await sb
      .from('transcript_entries')
      .select('grade_level, sem1_grade, sem2_grade')
      .eq('student_sheet_id', s.student_sheet_id);
    if (eErr) throw eErr;
    const probe = (grade, sem) =>
      (entries || []).some(
        (e) => e.grade_level === grade && looksLikeGrade(sem === 'S2' ? e.sem2_grade : e.sem1_grade)
      );
    const supaGate = hasRecentGradesWith(probe, s.class, nowLA);

    const d = [];
    for (const k of ['enough', 'reason', 'grade']) {
      if (String(sheetGate[k]) !== String(supaGate[k])) d.push(`${k} ${sheetGate[k]}≠${supaGate[k]}`);
    }
    if (d.length) {
      mismatch++;
      diffs.push(`  ✗ ${s.name} (${s.class}) — ${d.join(' · ')}`);
    } else {
      match++;
    }
    await sleep(60);
  }

  console.log('\n── TRANSCRIPT grade-gate shadow parity ──');
  console.log(`students checked: ${students.length} · now=${now.toISODate()}`);
  console.log(`  ✓ match:     ${match}`);
  console.log(`  ✗ mismatch:  ${mismatch}`);
  console.log(`  · unreadable Sheet: ${unreadable}`);
  if (diffs.length) {
    console.log('\nmismatches:');
    diffs.forEach((l) => console.log(l));
  } else {
    console.log('\n✓ Full parity — every student\'s grade-gate matches between Sheets and Supabase.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
