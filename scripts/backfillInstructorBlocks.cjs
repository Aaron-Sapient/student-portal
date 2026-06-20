/**
 * backfillInstructorBlocks.cjs — mirror Master `InstructorBlocks` → Supabase
 * `instructor_blocks` (Bucket A, availability; NOT student-scoped).
 *
 *   node scripts/backfillInstructorBlocks.cjs           # DRY RUN
 *   node scripts/backfillInstructorBlocks.cjs --write    # insert
 *
 * Source VERIFIED against lib/blocks.js:4,9-33,38-56 — range A:G:
 *   A instructor · B startDate · C endDate(→startDate if blank) · D reason
 *   E createdAt · F startTime · G endTime (F/G blank = all-day).
 * Dates/times read UNFORMATTED (serial or string) and normalized like blocks.js.
 *
 * TRANSFORM: the schema has a single `block_date`, but a source row is a DATE
 * RANGE → we EXPAND [startDate..endDate] into one row per date (same instructor/
 * time/reason). instructor must be 'aaron'/'ryan' (enum); others skipped+warned.
 * Idempotent-ish: this table has no natural unique key, so --write FIRST clears
 * existing instructor_blocks rows (it's a pure availability mirror, app-rebuilt).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const TAB = 'InstructorBlocks';
const SERIAL_EPOCH = DateTime.fromISO('1899-12-30');

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
}
// serial (days since 1899-12-30) or 'YYYY-MM-DD'/ISO string → 'YYYY-MM-DD' or null
function normDate(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return SERIAL_EPOCH.plus({ days: Math.round(v) }).toISODate();
  const d = DateTime.fromISO(String(v).trim(), { zone: 'America/Los_Angeles' });
  return d.isValid ? d.toISODate() : null;
}
// serial fraction of day or 'HH:mm' → 'HH:mm' or null
function normTime(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') {
    const min = Math.round(v * 24 * 60);
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  }
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

async function main() {
  const WRITE = process.argv.includes('--write');
  const get = loadEnv();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'), private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const rows = (await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID, range: `'${TAB}'!A2:G500`, valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.values || [];

  const records = [];
  const warnings = [];
  rows.forEach((r, i) => {
    const instructor = String(r?.[0] ?? '').trim().toLowerCase();
    const start = normDate(r?.[1]);
    if (!instructor && !start) return; // blank row
    if (instructor !== 'aaron' && instructor !== 'ryan') { warnings.push(`row ${i + 2}: bad instructor "${r?.[0]}" — skipped`); return; }
    if (!start) { warnings.push(`row ${i + 2} (${instructor}): unparseable startDate "${r?.[1]}" — skipped`); return; }
    const end = normDate(r?.[2]) || start;
    const reason = String(r?.[3] ?? '').trim() || null;
    const st = normTime(r?.[5]);
    const et = normTime(r?.[6]);
    let d = DateTime.fromISO(start), last = DateTime.fromISO(end), n = 0;
    if (last < d) { warnings.push(`row ${i + 2} (${instructor}): endDate<startDate — using startDate only`); last = d; }
    while (d <= last && n < 400) {
      records.push({ instructor, block_date: d.toISODate(), start_time: st, end_time: et, reason });
      d = d.plus({ days: 1 }); n++;
    }
  });

  console.log(`Resolved ${records.length} instructor_block date-rows from ${rows.length} source row(s).`);
  records.slice(0, 12).forEach((r) => console.log(`  ${r.instructor.padEnd(6)} ${r.block_date} ${r.start_time || 'all'}-${r.end_time || 'day'}  ${r.reason || ''}`));
  warnings.forEach((w) => console.log(`  ⚠ ${w}`));

  if (!WRITE) { console.log('\nDRY RUN — re-run with --write.'); return; }
  await sb.from('instructor_blocks').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (records.length) {
    const { error } = await sb.from('instructor_blocks').insert(records);
    if (error) { console.error('insert failed:', error.message); process.exit(1); }
  }
  console.log(`\n✓ Inserted ${records.length} instructor_blocks rows (table cleared first).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
