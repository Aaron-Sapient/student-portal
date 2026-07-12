/**
 * backfillCheckinSummary.cjs — mirror the '✅ Check-Ins' tab (Ryan's monthly cap
 * + meeting-pair dates) → Supabase `meeting_cap_summary` (Bucket A,
 * compliance_cap domain). ONE ROW PER STUDENT (current-state snapshot, not an
 * append log) — upsert on the student_sheet_id PK, same shape as
 * backfillStudents.cjs, not the append-log natural-key style of
 * backfillParentCheckins.cjs/backfillWrittenReports.cjs.
 *
 *   node scripts/backfillCheckinSummary.cjs           # DRY RUN
 *   node scripts/backfillCheckinSummary.cjs --write    # upsert (live-safe)
 *
 * Source VERIFIED against app/api/developer/checkinCompliance/route.js and
 * app/api/validateBooking/route.js, plus a live cell probe — '✅ Check-Ins'!A:M:
 *   A name · H(7) meetings used this month w/ Ryan · I(8) meetings allowed
 *   (blank = uncapped) · J(9) last Ryan meeting · K(10) upcoming Ryan meeting
 *   · L(11) last Aaron meeting · M(12) upcoming Aaron meeting.
 * J/K/L/M are Sheets date serials or the literal string "N/A" (verified live) —
 * normalized to an ISO instant at LA midnight; "N/A"/blank → NULL.
 * Student link: name-match vs Master col A (normalized), sheet_id from Master
 * col G — same join style as backfillParentCheckins.cjs. Unmatched rows are
 * skipped+warned (meeting_cap_summary.student_sheet_id is a NOT NULL FK).
 *
 * NOT handled here (documented residual, matches the guardians-removal note in
 * backfillStudents.cjs): a student removed from the Check-Ins tab entirely
 * leaves a stale mirror row rather than being pruned. In practice the tab's
 * roster tracks Master 1:1, so this is a low-probability edge, not a correctness
 * gap for the cap-check consumers (which the read-flip hasn't cut over yet).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = "'👩‍🎓 All Data'";
const CHECKINS_TAB = "'✅ Check-Ins'";
const SERIAL_EPOCH = DateTime.fromISO('1899-12-30', { zone: 'America/Los_Angeles' });

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const sheetId = (url) => { const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/); return m ? m[1] : null; };
const intOrNull = (v) => { if (v === '' || v == null) return null; const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
const meetingDateOrNull = (v) => {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return SERIAL_EPOCH.plus({ days: Math.round(v) }).toISO();
  const s = String(v).trim();
  if (!s || /^n\/?a$/i.test(s)) return null;
  const d = DateTime.fromISO(s, { zone: 'America/Los_Angeles' });
  return d.isValid ? d.toISO() : null;
};

async function main() {
  const WRITE = process.argv.includes('--write');
  const get = loadEnv();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'), private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const [master, ci] = (await sheets.spreadsheets.values.batchGet({
    spreadsheetId: MASTER_SHEET_ID, ranges: [`${MASTER_TAB}!A:G`, `${CHECKINS_TAB}!A:M`],
    valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.valueRanges.map((v) => v.values || []);

  const nameToId = {};
  for (const r of master) {
    const id = sheetId(r?.[6]); if (!id) continue;
    const n = norm(r?.[0]); if (n) nameToId[n] = id;
  }

  const records = [];
  const warns = [];
  const seenIds = new Set();
  ci.slice(1).forEach((r, i) => {
    const name = String(r?.[0] ?? '').trim();
    if (!name) return; // blank row
    const id = nameToId[norm(name)];
    if (!id) { warns.push(`row ${i + 2}: unresolved student "${name}"`); return; }
    if (seenIds.has(id)) { warns.push(`row ${i + 2}: "${name}" shares a sheet_id with an earlier row — skipped (dup fixture)`); return; }
    seenIds.add(id);
    records.push({
      student_sheet_id: id,
      student_name: name,
      meetings_used: intOrNull(r?.[7]),
      meetings_allowed: intOrNull(r?.[8]),
      last_ryan_meeting: meetingDateOrNull(r?.[9]),
      upcoming_ryan_meeting: meetingDateOrNull(r?.[10]),
      last_aaron_meeting: meetingDateOrNull(r?.[11]),
      upcoming_aaron_meeting: meetingDateOrNull(r?.[12]),
    });
  });

  console.log(`Resolved ${records.length} meeting_cap_summary rows; ${warns.length} unresolved skipped.`);
  records.slice(0, 8).forEach((r) => console.log(`  ${r.student_name.padEnd(22)} used=${r.meetings_used ?? '-'} allowed=${r.meetings_allowed ?? 'uncapped'}  ${r.student_sheet_id.slice(0, 10)}…`));
  warns.slice(0, 15).forEach((w) => console.log(`  ⚠ ${w}`));

  if (!WRITE) { console.log('\nDRY RUN — re-run with --write.'); return; }
  if (records.length) {
    const { error } = await sb.from('meeting_cap_summary').upsert(records, { onConflict: 'student_sheet_id' });
    if (error) { console.error('upsert failed:', error.message); process.exit(1); }
  }
  console.log(`\n✓ Upserted ${records.length} meeting_cap_summary rows (live-safe; no delete window).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
