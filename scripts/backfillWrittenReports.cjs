/**
 * backfillWrittenReports.cjs — mirror Master `WrittenReports!A:H` → Supabase
 * `written_reports` (Bucket A/B). The Master tab is the STRUCTURED source of
 * truth; body_html (the per-student rich-text rendered copy) is left NULL — it's
 * derivable from the on_target/needs_attention/strategy/parent_requests text.
 *
 *   node scripts/backfillWrittenReports.cjs           # DRY RUN
 *   node scripts/backfillWrittenReports.cjs --write    # insert
 *
 * Source VERIFIED against developer/writtenReports/route.js:11-14,158-172 — cols:
 *   A date(serial) · B studentName · C onTarget · D needsAttention · E strategy
 *   · F parentRequests · G status(bool) · H parentNotified(bool).
 * Student link = col B name → Master col A → col G sheet_id. Date read UNFORMATTED
 * (sheet serial) → ISO. No natural unique key → --write clears the table first.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = "'👩‍🎓 All Data'";
const SERIAL_EPOCH = DateTime.fromISO('1899-12-30');

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const sheetId = (url) => { const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/); return m ? m[1] : null; };
const t = (v) => { const s = String(v ?? '').trim(); return s || null; };
const truthy = (v) => v === true || /^(true|1|yes|✓)$/i.test(String(v ?? '').trim());
function serialDate(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return SERIAL_EPOCH.plus({ days: Math.round(v) }).toISODate();
  const d = DateTime.fromISO(String(v).trim()); if (d.isValid) return d.toISODate();
  const j = new Date(String(v)); return isNaN(j) ? null : j.toISOString().slice(0, 10);
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

  const master = (await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: `${MASTER_TAB}!A:G` })).data.values || [];
  const wr = (await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID, range: `'WrittenReports'!A:H`, valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.values || [];

  const nameToId = {};
  for (const r of master) { const id = sheetId(r?.[6]); const n = norm(r?.[0]); if (n && id) nameToId[n] = id; }

  const records = [];
  const warns = [];
  wr.forEach((r, i) => {
    const name = String(r?.[1] ?? '').trim();
    const report_date = serialDate(r?.[0]);
    if (!name && !report_date) return;               // blank
    if (norm(name) === 'student' || /^date$/i.test(String(r?.[0]))) return; // header
    const id = nameToId[norm(name)];
    if (!id) { warns.push(`row ${i + 1}: no Master match for "${name}"`); return; }
    records.push({
      student_sheet_id: id, report_date, on_target: t(r?.[2]), needs_attention: t(r?.[3]),
      strategy: t(r?.[4]), parent_requests: t(r?.[5]), body_html: null,
      status: truthy(r?.[6]), parent_notified: truthy(r?.[7]),
    });
  });

  console.log(`Resolved ${records.length} written_reports; ${warns.length} unmatched skipped.`);
  records.slice(0, 8).forEach((r) => console.log(`  ${r.report_date || '????'} status=${r.status ? 'Y' : 'n'} notified=${r.parent_notified ? 'Y' : 'n'} ${r.student_sheet_id.slice(0, 10)}…  onTarget="${String(r.on_target).slice(0, 30)}"`));
  warns.slice(0, 15).forEach((w) => console.log(`  ⚠ ${w}`));

  if (!WRITE) { console.log('\nDRY RUN — re-run with --write.'); return; }
  await sb.from('written_reports').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  for (let i = 0; i < records.length; i += 500) {
    const { error } = await sb.from('written_reports').insert(records.slice(i, i + 500));
    if (error) { console.error('insert failed:', error.message); process.exit(1); }
  }
  console.log(`\n✓ Inserted ${records.length} written_reports (table cleared first).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
