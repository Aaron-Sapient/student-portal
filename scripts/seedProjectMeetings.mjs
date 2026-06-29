/**
 * seedProjectMeetings.mjs — one-time setup of the initial project-meeting plans, plus
 * Manusri's ART-flag flip. Idempotent: skips a student who already has an active plan,
 * and only flips the ART flag if it's currently TRUE. Prints everything it does.
 *
 *   node scripts/seedProjectMeetings.mjs           # dry run (prints what it WOULD do)
 *   node scripts/seedProjectMeetings.mjs --commit   # actually write
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes('--commit');

const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
const getEnv = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
};

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const IS_ART_COL_IDX = 54; // col BC

const sb = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: getEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    private_key: getEnv('GOOGLE_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// The initial cohort. `match` is a case-insensitive substring against Master col A (name).
const TARGETS = [
  { match: 'Vaibhav Gaddam', teacher: 'aaron', minutes: 30, label: 'Solo Research' },
  { match: 'Krrish Sardar', teacher: 'aaron', minutes: 30, label: 'Solo Research + Book Project' },
  { match: 'Manusri', teacher: 'aaron', minutes: 15, label: 'Solo Research', unsetART: true },
];

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: MASTER_SHEET_ID,
  range: `${MASTER_TAB}!A:BD`,
  valueRenderOption: 'UNFORMATTED_VALUE',
});
const rows = res.data.values || [];

console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN (pass --commit to write)'}\n`);

for (const t of TARGETS) {
  const idxs = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => String(r[0] || '').toLowerCase().includes(t.match.toLowerCase()));
  if (idxs.length === 0) { console.log(`✗ ${t.match}: NO Master row matched — skipping.`); continue; }
  if (idxs.length > 1) {
    console.log(`✗ ${t.match}: ${idxs.length} Master rows matched (${idxs.map(({ r }) => r[0]).join(', ')}) — skipping, disambiguate manually.`);
    continue;
  }
  const { r, i } = idxs[0];
  const rowIndex = i + 1; // 1-based sheet row
  const name = String(r[0] || '').trim();
  const portalUrl = String(r[6] || '');
  const email = String(r[9] || '').trim();
  const sheetMatch = portalUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
  const studentSheetId = sheetMatch?.[1] || null;
  const isART = r[IS_ART_COL_IDX] === 'TRUE' || r[IS_ART_COL_IDX] === true;

  console.log(`• ${name}  <${email || 'no-email'}>  sheet=${studentSheetId || 'MISSING'}  ART=${isART}`);
  if (!studentSheetId) { console.log(`  ✗ no student sheet id in portal URL — skipping.`); continue; }

  // 1) Project plan (skip if an active one already exists).
  const { data: existing } = await sb
    .from('project_meeting_plans')
    .select('id, minutes, label, teacher')
    .eq('student_sheet_id', studentSheetId)
    .eq('active', true);
  if ((existing || []).length > 0) {
    console.log(`  = already has an active plan (${existing.map((p) => `${p.minutes}m ${p.label}`).join('; ')}) — skipping insert.`);
  } else if (COMMIT) {
    const { data, error } = await sb
      .from('project_meeting_plans')
      .insert({ student_sheet_id: studentSheetId, student_email: email || null, teacher: t.teacher, minutes: t.minutes, label: t.label, granted_by: 'seed' })
      .select()
      .single();
    console.log(error ? `  ✗ plan insert failed: ${error.message}` : `  + plan created: ${data.minutes}m ${data.label} with ${data.teacher} (id ${data.id})`);
  } else {
    console.log(`  + WOULD create plan: ${t.minutes}m "${t.label}" with ${t.teacher}`);
  }

  // 2) ART-flag flip (Manusri): only if currently TRUE.
  if (t.unsetART) {
    if (!isART) {
      console.log(`  = ART already FALSE — no flip needed.`);
    } else if (COMMIT) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!BC${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[false]] },
      });
      console.log(`  + ART flag (BC${rowIndex}) set FALSE.`);
    } else {
      console.log(`  + WOULD set ART flag (BC${rowIndex}) FALSE.`);
    }
  }
}

console.log('\nDone.');
