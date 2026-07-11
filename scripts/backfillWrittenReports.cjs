/**
 * backfillWrittenReports.cjs — mirror Master `WrittenReports!A:H` → Supabase
 * `written_reports` (Bucket A/B). The Master tab is the STRUCTURED source of
 * truth; body_html (the per-student rich-text rendered copy) is left NULL — it's
 * derivable from the on_target/needs_attention/strategy/parent_requests text.
 *
 *   node scripts/backfillWrittenReports.cjs             # DRY RUN
 *   node scripts/backfillWrittenReports.cjs --write     # initial clean backfill (delete-then-insert)
 *   node scripts/backfillWrittenReports.cjs --write --reconcile  # live-safe upsert on sheet_row
 *
 * Source VERIFIED against developer/writtenReports/route.js:10-15,156-172 — cols:
 *   A date · B studentName · C onTarget · D needsAttention · E strategy
 *   · F parentRequests · G status(bool) · H parentNotified(bool).
 * Student link = col B name → Master col A → col G sheet_id. Col A is plain ISO
 * TEXT (verified — NOT a serial), so report_at = the raw instant and report_date =
 * its America/Los_Angeles day. sheet_row (the 1-based tab row = the route's
 * rowIndex) is the natural key the app dual-write + this backfill converge on.
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
    // Col A is plain ISO TEXT (verified — not a serial), full ms precision.
    const reportAtIso = (() => {
      const d = DateTime.fromISO(String(r?.[0] ?? '').trim(), { zone: 'utc' });
      return d.isValid ? d.toISO() : null;
    })();
    // report_date = the America/Los_Angeles day of report_at (fixes the prior
    // machine-tz off-by-one for reports stamped 00:00–08:00Z).
    const report_date = reportAtIso
      ? DateTime.fromISO(reportAtIso, { zone: 'utc' }).setZone('America/Los_Angeles').toISODate()
      : serialDate(r?.[0]);   // legacy fallback (no such rows today)
    if (!name && !report_date) return;               // blank
    if (norm(name) === 'student' || /^date$/i.test(String(r?.[0]))) return; // header
    const id = nameToId[norm(name)];
    if (!id) { warns.push(`row ${i + 1}: no Master match for "${name}"`); return; }
    records.push({
      sheet_row: i + 1,                            // true 1-based sheet row (= route rowIndex)
      student_sheet_id: id, student_name: name || null,
      report_at: reportAtIso, report_date,
      on_target: t(r?.[2]), needs_attention: t(r?.[3]),
      strategy: t(r?.[4]), parent_requests: t(r?.[5]), body_html: null,
      status: truthy(r?.[6]), parent_notified: truthy(r?.[7]),
    });
  });

  console.log(`Resolved ${records.length} written_reports; ${warns.length} unmatched skipped.`);
  records.slice(0, 8).forEach((r) => console.log(`  ${r.report_date || '????'} status=${r.status ? 'Y' : 'n'} notified=${r.parent_notified ? 'Y' : 'n'} ${r.student_sheet_id.slice(0, 10)}…  onTarget="${String(r.on_target).slice(0, 30)}"`));
  warns.slice(0, 15).forEach((w) => console.log(`  ⚠ ${w}`));

  if (!WRITE) { console.log('\nDRY RUN — re-run with --write (add --reconcile for live-safe upsert).'); return; }
  const RECONCILE = process.argv.includes('--reconcile');
  if (RECONCILE) {
    // Live-safe: upsert on sheet_row (no delete window). Refreshes status +
    // parent_notified (the external Apps Script writes col H) + any field edits.
    // Requires the unique index on sheet_row (added after the initial backfill).
    for (let i = 0; i < records.length; i += 500) {
      const { error } = await sb.from('written_reports')
        .upsert(records.slice(i, i + 500), { onConflict: 'sheet_row', ignoreDuplicates: false });
      if (error) { console.error('upsert failed:', error.message); process.exit(1); }
    }
    console.log(`\n✓ Upserted ${records.length} written_reports (sheet_row key; live-safe, no delete window).`);
  } else {
    // Initial clean backfill only (flag off): delete-then-insert to reset the
    // table with sheet_row/report_at/student_name populated for every row.
    await sb.from('written_reports').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    for (let i = 0; i < records.length; i += 500) {
      const { error } = await sb.from('written_reports').insert(records.slice(i, i + 500));
      if (error) { console.error('insert failed:', error.message); process.exit(1); }
    }
    console.log(`\n✓ Inserted ${records.length} written_reports (table cleared first — initial backfill).`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
