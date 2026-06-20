/**
 * backfillParentCheckins.cjs — mirror Master `ParentCheckins!A:H` → Supabase
 * `parent_checkins` (Bucket A). One row per parent submission.
 *
 *   node scripts/backfillParentCheckins.cjs           # DRY RUN
 *   node scripts/backfillParentCheckins.cjs --write    # insert
 *
 * Source VERIFIED against lib/parentCheckinCore.js:296-313 — cols:
 *   A ts · B parentEmail · C studentName · D purpose · E deadlines
 *   · F daysSinceLast · G urgencyLevel · H reasoning.
 * Student link (parentCheckinCore.js:177-189): match parent email vs Master
 * K(10)/L(11) AND/OR studentName vs Master A(0); sheet_id from Master G(6).
 * Resolution order: (1) studentName name-match; (2) if email maps to exactly
 * ONE student, use it; else skip+warn (can't disambiguate, FK needs a real id).
 * No natural unique key → --write clears `parent_checkins` first.
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
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const lc = (s) => String(s || '').trim().toLowerCase();
const sheetId = (url) => { const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/); return m ? m[1] : null; };
const tsOrNull = (v) => { const s = String(v ?? '').trim(); if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d.toISOString(); };
const t = (v) => { const s = String(v ?? '').trim(); return s || null; };

async function main() {
  const WRITE = process.argv.includes('--write');
  const get = loadEnv();
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'), private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const [master, pc] = (await sheets.spreadsheets.values.batchGet({
    spreadsheetId: MASTER_SHEET_ID, ranges: [`${MASTER_TAB}!A:L`, `'ParentCheckins'!A:H`],
  })).data.valueRanges.map((v) => v.values || []);

  const nameToId = {};
  const emailToIds = {};
  for (const r of master) {
    const id = sheetId(r?.[6]); if (!id) continue;
    const n = norm(r?.[0]); if (n) nameToId[n] = id;
    [r?.[10], r?.[11]].forEach((e) => { const k = lc(e); if (k) (emailToIds[k] ||= new Set()).add(id); });
  }

  const records = [];
  const warns = [];
  pc.forEach((r, i) => {
    const submitted_at = tsOrNull(r?.[0]);
    const parent_email = lc(r?.[1]);
    const student_name = String(r?.[2] ?? '').trim();
    if (!submitted_at && !parent_email) return;   // blank
    if (!submitted_at) return;                     // header
    let id = nameToId[norm(student_name)] || null;
    if (!id) {
      const ids = emailToIds[parent_email];
      if (ids && ids.size === 1) id = [...ids][0];
    }
    if (!id) { warns.push(`row ${i + 1}: unresolved (name "${student_name}", email "${parent_email}")`); return; }
    records.push({
      student_sheet_id: id, parent_email: parent_email || null, submitted_at, urgency: t(r?.[6]),
      payload: { student_name: student_name || null, purpose: t(r?.[3]), deadlines: t(r?.[4]), days_since_last_request: t(r?.[5]), reasoning: t(r?.[7]) },
    });
  });

  console.log(`Resolved ${records.length} parent_checkins; ${warns.length} unresolved skipped.`);
  records.slice(0, 8).forEach((r) => console.log(`  ${String(r.submitted_at).slice(0, 10)} ${String(r.urgency).slice(0, 18).padEnd(18)} ${r.parent_email}  ${r.student_sheet_id.slice(0, 10)}…`));
  warns.slice(0, 15).forEach((w) => console.log(`  ⚠ ${w}`));

  if (!WRITE) { console.log('\nDRY RUN — re-run with --write.'); return; }
  await sb.from('parent_checkins').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (records.length) {
    const { error } = await sb.from('parent_checkins').insert(records);
    if (error) { console.error('insert failed:', error.message); process.exit(1); }
  }
  console.log(`\n✓ Inserted ${records.length} parent_checkins (table cleared first).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
