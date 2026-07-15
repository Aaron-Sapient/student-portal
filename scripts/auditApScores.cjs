/**
 * auditApScores.cjs — READ-ONLY audit of AP score self-reporting.
 *
 *   node scripts/auditApScores.cjs
 *
 * For every active student who has completed a grade that could carry AP
 * exams (9th-12th, per the same gradeYearJustCompleted() rule the check-in
 * form itself uses — lib/apScores.js), reports:
 *   - whether they've submitted this year's AP Scores check-in
 *     (Supabase ap_score_reports, report_year = current calendar year)
 *   - which AP-named courses (^AP + space/capital, same regex the form uses
 *     to auto-detect) appear in their transcript for the just-completed
 *     grade block
 *
 * Flags anyone who has NOT submitted but whose transcript shows at least one
 * detected AP course — i.e. likely took an AP exam and hasn't self-reported.
 *
 * Read-only against both Sheets and Supabase. No writes.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const QUOTA_USER = 'audit-ap-scores';
const AP_NAME_RE = /^AP(\s|[A-Z])/i;
const TRANSCRIPT_ROWS = { '9th': [6, 15], '10th': [24, 33], '11th': [6, 15], '12th': [24, 33] };
const TRANSCRIPT_NAME_COL = { '9th': 'E', '10th': 'E', '11th': 'P', '12th': 'P' };

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors lib/identity.js classYearFromClass()
function classYearFromClass(klass) {
  const m = String(klass ?? '').match(/(\d{2})\s*$/);
  return m ? 2000 + Number(m[1]) : null;
}

// Mirrors lib/apScores.js gradeYearJustCompleted()
function gradeYearJustCompleted(gradYear, nowYear) {
  if (!Number.isFinite(gradYear)) return null;
  const yearsBeforeGrad = gradYear - nowYear;
  const map = { 0: '12th', 1: '11th', 2: '10th', 3: '9th' };
  return map[yearsBeforeGrad] ?? null;
}

async function getDetectedApCourses(sheets, studentSheetId, gradeYear) {
  if (!gradeYear || !TRANSCRIPT_ROWS[gradeYear]) return [];
  const [startRow, endRow] = TRANSCRIPT_ROWS[gradeYear];
  const col = TRANSCRIPT_NAME_COL[gradeYear];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: `🎓 Transcript!${col}${startRow}:${col}${endRow}`,
      quotaUser: QUOTA_USER,
    });
    const names = (res.data.values || []).map((r) => String(r?.[0] ?? '').trim());
    return names.filter((n) => AP_NAME_RE.test(n));
  } catch (err) {
    return { __error: err.message || String(err) };
  }
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

  const nowYear = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric' });
  const reportYear = Number(nowYear);

  const { data: students, error } = await sb
    .from('students')
    .select('student_sheet_id, name, class')
    .eq('status', 'active')
    .order('name');
  if (error) throw error;

  const { data: reportRows, error: repErr } = await sb
    .from('ap_score_reports')
    .select('student_sheet_id')
    .eq('report_year', reportYear);
  if (repErr) throw repErr;
  const submittedIds = new Set((reportRows || []).map((r) => r.student_sheet_id));

  const flagged = [];
  const submitted = [];
  const clean = []; // not submitted, no AP detected
  const skippedNoGrade = []; // gradeYearJustCompleted() is null (e.g. incoming 9th grader)
  const readErrors = [];

  for (const s of students) {
    const gradYear = classYearFromClass(s.class);
    const gradeYear = gradeYearJustCompleted(gradYear, reportYear);
    if (!gradeYear) {
      skippedNoGrade.push({ name: s.name, class: s.class });
      continue;
    }

    const hasSubmitted = submittedIds.has(s.student_sheet_id);
    const detected = await getDetectedApCourses(sheets, s.student_sheet_id, gradeYear);
    await sleep(60); // gentle pacing under the per-project Sheets quota

    if (detected && detected.__error) {
      readErrors.push({ name: s.name, sheetId: s.student_sheet_id, error: detected.__error });
      continue;
    }

    const record = { name: s.name, sheetId: s.student_sheet_id, class: s.class, gradeYear, courses: detected, submitted: hasSubmitted };
    if (hasSubmitted) submitted.push(record);
    else if (detected.length > 0) flagged.push(record);
    else clean.push(record);
  }

  console.log(`\n=== AP Scores audit — report_year ${reportYear} ===\n`);
  console.log(`Active students considered (grade-eligible for AP): ${students.length - skippedNoGrade.length}`);
  console.log(`  Submitted this year:                 ${submitted.length}`);
  console.log(`  NOT submitted, no AP course detected: ${clean.length}`);
  console.log(`  NOT submitted, AP course(s) detected: ${flagged.length}  <-- FLAGGED`);
  console.log(`  Skipped (no completed AP-eligible grade yet): ${skippedNoGrade.length}`);
  if (readErrors.length) console.log(`  Transcript read errors: ${readErrors.length}`);

  console.log(`\n--- FLAGGED: likely took AP exam(s), hasn't self-reported ---`);
  for (const r of flagged) {
    console.log(`  ${r.name}  (${r.class}, completed ${r.gradeYear})  sheetId=${r.sheetId}`);
    for (const c of r.courses) console.log(`      - ${c}`);
  }
  if (!flagged.length) console.log('  (none)');

  if (readErrors.length) {
    console.log(`\n--- Transcript read errors (excluded from counts above) ---`);
    for (const r of readErrors) console.log(`  ${r.name}  sheetId=${r.sheetId}  ${r.error}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
