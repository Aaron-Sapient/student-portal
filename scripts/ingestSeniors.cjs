/**
 * ingestSeniors.cjs — mirror the Class-of-2027 senior roster from the Master
 * "Class of 2027 Table" tab into the Supabase `seniors` table. Drives the
 * portal's deterministic, token-free senior booking (see lib/seniors.js).
 *
 *   node scripts/ingestSeniors.cjs            # DRY RUN (resolve + print, no write)
 *   node scripts/ingestSeniors.cjs --write    # upsert into Supabase
 *   node scripts/ingestSeniors.cjs --write --prune   # also delete rows no longer in the tab
 *
 * Joins the roster (Name/Package/Teacher/Phase) to the Master "👩‍🎓 All Data"
 * tab by name to resolve student_sheet_id (col G) + student_email (col J). Roster
 * integrity matters more than partial success: if ANY row fails to resolve or
 * validate, the whole batch is ABORTED (nothing is written). Idempotent: upsert
 * on student_sheet_id. Read-only against Google.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = "'👩‍🎓 All Data'";
const ROSTER_TAB = "'Class of 2027 Table'";

// package (lowercased from the sheet) -> derived columns. lib/seniors.js
// PACKAGE_RULES is the authoritative logic; these just mirror into SQL.
const PACKAGE_DERIVED = {
  vip: { meetings_per_week: 2, meeting_minutes: 30 },
  comprehensive: { meetings_per_week: 2, meeting_minutes: 30 },
  essential: { meetings_per_week: 2, meeting_minutes: null }, // 40-min budget: 1×40 or 2×20
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

async function main() {
  const args = process.argv.slice(2);
  const WRITE = args.includes('--write');
  const PRUNE = args.includes('--prune');

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

  // Roster: A=Name, B=Package, C=Teacher, D=Phase (rows beyond the table are blank in A).
  const roster =
    (
      await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${ROSTER_TAB}!A2:D60`,
      })
    ).data.values || [];

  // Master roster: name(norm) -> { sheetId, email, cls }
  const master =
    (
      await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!A:J`,
      })
    ).data.values || [];
  const byName = {};
  for (const r of master) {
    const n = norm(r[0]);
    if (!n) continue;
    const m = String(r[6] || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
    byName[n] = {
      name: String(r[0] || '').trim(),
      sheetId: m ? m[1] : null,
      email: String(r[9] || '').trim().toLowerCase(),
      cls: String(r[1] || '').trim(),
    };
  }

  const records = [];
  const errors = [];
  for (const row of roster) {
    const name = String(row[0] || '').trim();
    if (!name) continue; // blank row = end of table
    const pkg = String(row[1] || '').trim().toLowerCase();
    const teacher = String(row[2] || '').trim().toLowerCase();
    const phase = Number(String(row[3] || '').trim());

    const problems = [];
    if (!PACKAGE_DERIVED[pkg]) problems.push(`bad package "${row[1]}"`);
    if (teacher !== 'aaron' && teacher !== 'ryan') problems.push(`bad teacher "${row[2]}"`);
    if (!Number.isInteger(phase) || phase < 1 || phase > 4) problems.push(`bad phase "${row[3]}"`);

    const info = byName[norm(name)];
    if (!info) problems.push('no Master match');
    else {
      if (!info.sheetId) problems.push('no student_sheet_id (Master col G)');
      if (!info.email) problems.push('no email (Master col J)');
    }

    if (problems.length) {
      errors.push(`${name}: ${problems.join('; ')}`);
      continue;
    }
    const derived = PACKAGE_DERIVED[pkg];
    records.push({
      student_sheet_id: info.sheetId,
      student_email: info.email,
      student_name: name,
      package: pkg,
      meetings_per_week: derived.meetings_per_week,
      meeting_minutes: derived.meeting_minutes,
      primary_teacher: teacher,
      phase,
      active: true,
      updated_at: new Date().toISOString(),
    });
  }

  console.log(`Resolved ${records.length} senior(s) from ${ROSTER_TAB}:`);
  for (const r of records) {
    console.log(
      `  ✓ ${r.student_name.padEnd(22)} ${r.package.padEnd(13)} ${r.primary_teacher.padEnd(5)} phase ${r.phase}  ${r.student_email}`
    );
  }
  if (errors.length) {
    console.log(`\n✗ ${errors.length} problem row(s) — ABORTING, nothing written:`);
    errors.forEach((e) => console.log(`  ✗ ${e}`));
    process.exit(1);
  }

  if (!WRITE) {
    console.log(`\nDRY RUN — re-run with --write to upsert ${records.length} row(s).`);
    return;
  }

  const { error } = await sb.from('seniors').upsert(records, { onConflict: 'student_sheet_id' });
  if (error) {
    console.error('Upsert failed:', error.message);
    process.exit(1);
  }
  console.log(`\n✓ Upserted ${records.length} senior(s).`);

  if (PRUNE) {
    const keep = new Set(records.map((r) => r.student_sheet_id));
    const { data: existing } = await sb.from('seniors').select('student_sheet_id, student_name');
    const stale = (existing || []).filter((r) => !keep.has(r.student_sheet_id));
    for (const r of stale) {
      await sb.from('seniors').delete().eq('student_sheet_id', r.student_sheet_id);
      console.log(`  – pruned ${r.student_name} (${r.student_sheet_id})`);
    }
    console.log(`Pruned ${stale.length} stale row(s).`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
