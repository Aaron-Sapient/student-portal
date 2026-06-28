/**
 * shadowCompareOverview.cjs — parity gate for the `overview_profile` domain.
 *
 *   node scripts/shadowCompareOverview.cjs
 *
 * For every active student, reads 🔎 Overview the SAME way lib/generateReport.js
 * does (UNFORMATTED B2:D20 → {name, year, major, sat, numAPs}) and compares it to
 * the Supabase mirror (student_profiles), reconstructing the identical shape. Prints
 * a ✓/MISMATCH per student and a summary — the "clean parity before flip" evidence
 * (the score_params/roster gate). Read-only against both sources.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function overviewFromSheetRows(ov, studentName) {
  return {
    name: ov[0]?.[0] || studentName,
    year: ov[2]?.[1] || '',
    major: ov[4]?.[1] || '',
    sat: ov[15]?.[1] || '',
    numAPs: ov[16]?.[1] || '',
  };
}
function overviewFromProfile(p, studentName) {
  return {
    name: (p?.display_name ?? '') || studentName,
    year: p?.current_year ?? '',
    major: p?.major ?? '',
    sat: p?.sat ?? '',
    numAPs: p?.num_aps ?? '',
  };
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

  const { data: students, error } = await sb
    .from('students')
    .select('student_sheet_id, name')
    .eq('status', 'active')
    .order('name');
  if (error) throw error;

  const { data: profiles, error: pErr } = await sb
    .from('student_profiles')
    .select('student_sheet_id, display_name, current_year, major, sat, num_aps');
  if (pErr) throw pErr;
  const byId = Object.fromEntries((profiles || []).map((p) => [p.student_sheet_id, p]));

  let match = 0;
  let mismatch = 0;
  let skipped = 0;
  const keys = ['name', 'year', 'major', 'sat', 'numAPs'];

  for (const s of students) {
    let ov;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: s.student_sheet_id,
        range: '🔎 Overview!B2:D20',
        valueRenderOption: 'UNFORMATTED_VALUE',
        quotaUser: 'shadow-overview',
      });
      ov = res.data.values || [];
    } catch (e) {
      console.log(`—  ${s.name}: Sheets read failed (${e.message.slice(0, 40)})`);
      skipped++;
      await sleep(80);
      continue;
    }
    const fromSheet = overviewFromSheetRows(ov, s.name);
    const fromSupa = overviewFromProfile(byId[s.student_sheet_id], s.name);
    const diffs = keys
      .filter((k) => String(fromSheet[k]) !== String(fromSupa[k]))
      .map((k) => `${k}: ${JSON.stringify(fromSheet[k])} != ${JSON.stringify(fromSupa[k])}`);
    if (diffs.length) {
      console.log(`✗  ${s.name} — ${diffs.join(' · ')}`);
      mismatch++;
    } else {
      match++;
    }
    await sleep(80);
  }

  console.log(`\noverview_profile parity: ${match} match · ${mismatch} mismatch · ${skipped} skipped (of ${students.length}).`);
  if (mismatch) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
