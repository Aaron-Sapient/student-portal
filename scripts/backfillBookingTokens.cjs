/**
 * backfillBookingTokens.cjs — mirror the NON-SENIOR meeting-token gate from
 * Master `👩‍🎓 All Data` cols AZ(51)=ryan, BB(53)=aaron → Supabase
 * `booking_tokens` (one row per (student, instructor)). Bucket A.
 *
 *   node scripts/backfillBookingTokens.cjs           # DRY RUN
 *   node scripts/backfillBookingTokens.cjs --write    # upsert
 *
 * Source VERIFIED against validateBooking/route.js:11-13, lib/instructors.js:
 *   AZ(51) ryan token: 15min/30min/pending/written/no/'' ; BB(53) aaron token:
 *   15min/30min/email/pending/no/''. token 'no' = consumed (student booked).
 *
 * SENIORS are EXCLUDED — they use the senior_checkin_grants/senior_bookings
 * ledger, never these columns (fetched from the live `seniors` table to skip).
 * Only rows with a NON-EMPTY token are written (no noise rows for ungated kids).
 * granted_at left NULL (the sheet has no per-instructor grant timestamp).
 * NOTE: col BD(55) = ART last-booking ISO timestamp — NOT migrated: the
 * instructor enum is (aaron|ryan) only, so ART has no home in this schema (gap
 * flagged; art_eligible already lives on students). Count logged below.
 * Idempotent: upsert on (student_sheet_id, instructor).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = "'👩‍🎓 All Data'";

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
}
const sheetId = (url) => { const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/); return m ? m[1] : null; };

async function main() {
  const WRITE = process.argv.includes('--write');
  const get = loadEnv();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'), private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  // seniors to exclude (table membership = senior, per lib/seniorsCore)
  const { data: seniorRows, error: sErr } = await sb.from('seniors').select('student_sheet_id');
  if (sErr) { console.error('could not read seniors:', sErr.message); process.exit(1); }
  const seniors = new Set((seniorRows || []).map((r) => r.student_sheet_id));

  const rows = (await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID, range: `${MASTER_TAB}!A:BD`,
  })).data.values || [];

  const records = [];
  let seniorSkipped = 0, artCount = 0;
  rows.forEach((r) => {
    const id = sheetId(r?.[6]);
    if (!id) return;
    if (seniors.has(id)) { seniorSkipped++; return; }
    if (String(r?.[55] ?? '').trim()) artCount++;
    [['ryan', 51], ['aaron', 53]].forEach(([instructor, idx]) => {
      const token = String(r?.[idx] ?? '').trim();
      if (!token) return;
      records.push({ student_sheet_id: id, instructor, token_value: token, granted_at: null, consumed: token.toLowerCase() === 'no', updated_at: new Date().toISOString() });
    });
  });

  const byVal = {};
  records.forEach((r) => { byVal[r.token_value] = (byVal[r.token_value] || 0) + 1; });
  console.log(`Resolved ${records.length} booking_tokens (${seniorSkipped} senior rows skipped; ${artCount} non-seniors carry an ART timestamp in BD — not migrated).`);
  console.log(`  token_value distribution: ${JSON.stringify(byVal)}`);
  records.slice(0, 12).forEach((r) => console.log(`  ${r.instructor.padEnd(6)} ${r.token_value.padEnd(8)} consumed=${r.consumed}  ${r.student_sheet_id.slice(0, 12)}…`));

  if (!WRITE) { console.log('\nDRY RUN — re-run with --write.'); return; }
  const { error } = await sb.from('booking_tokens').upsert(records, { onConflict: 'student_sheet_id,instructor' });
  if (error) { console.error('upsert failed:', error.message); process.exit(1); }
  console.log(`\n✓ Upserted ${records.length} booking_tokens.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
