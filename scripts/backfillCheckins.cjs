/**
 * backfillCheckins.cjs — mirror weekly check-ins from Master `CheckinForm`
 * (Ryan, A:L) + `A_CheckinForm` (Aaron, A:J) → Supabase `checkins` (Bucket A).
 * One row per form submission; instructor distinguishes the two forms.
 *
 *   node scripts/backfillCheckins.cjs           # DRY RUN
 *   node scripts/backfillCheckins.cjs --write    # insert
 *
 * Source VERIFIED against submitUpdateForm/route.js + submitAaronUpdateForm +
 * bookMeeting (form column layouts) and checkinDecision (gate vocab):
 *  Ryan CheckinForm:  A ts · B name · C grades · D tests&deadlines · E taskUpdates
 *    · F concernCat · G concernText · H selfRating · I respPref · J agenda
 *    · K routingReason · L decision(gate: pending/written/15min/30min)
 *  Aaron A_CheckinForm: A ts · B name · C taskUpdates · D deadlines · E concernCat
 *    · F concernText · G respPref · H agenda · I routingReason · J decision(gate: 15min/30min/email)
 * Student link = form col B (name) → Master col A name → col G sheet_id.
 * Unmatched names (incl. header rows) are skipped+warned. No natural unique key
 * → --write clears `checkins` first (pure historical mirror).
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
const words = (s) => String(s || '').toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, '')).filter(Boolean);
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

  const [master, ryan, aaron] = (await sheets.spreadsheets.values.batchGet({
    spreadsheetId: MASTER_SHEET_ID,
    ranges: [`${MASTER_TAB}!A:G`, `'CheckinForm'!A:L`, `'A_CheckinForm'!A:J`],
  })).data.valueRanges.map((v) => v.values || []);

  // Roster for name resolution: exact norm-match, then UNIQUE token-subset match
  // (handles first-name-only form entries like "Vedant" → "Vedant Narayansa";
  // refuses ambiguous cases like "Seoah Baek" vs "Victoria Baek").
  const exactMap = {};
  const roster = [];
  for (const r of master) {
    const id = sheetId(r?.[6]); if (!id) continue;
    const e = norm(r?.[0]); if (e) exactMap[e] = id;
    roster.push({ id, tokens: new Set(words(r?.[0])) });
  }
  // Confirmed aliases (Aaron, 6/20): a form name that is a different name for a
  // roster student. 'Seoah Baek' (Korean name) = 'Victoria Baek'.
  const NAME_ALIASES = { seoahbaek: 'victoriabaek' };
  const subsetHits = [];
  const resolveName = (name) => {
    const e = NAME_ALIASES[norm(name)] || norm(name); if (exactMap[e]) return exactMap[e];
    const ft = words(name); if (!ft.length) return null;
    const cands = roster.filter((s) => ft.every((w) => s.tokens.has(w)));
    if (cands.length === 1) { subsetHits.push(name); return cands[0].id; }
    return null;
  };

  const records = [];
  const warns = [];
  const ingest = (rows, instructor, gateIdx, mapPayload) => {
    rows.forEach((r, i) => {
      const submitted_at = tsOrNull(r?.[0]);
      const name = String(r?.[1] ?? '').trim();
      if (!submitted_at && !name) return;       // blank row
      if (!submitted_at) return;                 // header / non-data row
      const id = resolveName(name);
      if (!id) { warns.push(`${instructor} row ${i + 1}: no Master match for "${name}"`); return; }
      records.push({ student_sheet_id: id, instructor, submitted_at, gate_state: t(r?.[gateIdx]), payload: mapPayload(r) });
    });
  };
  ingest(ryan, 'ryan', 11, (r) => ({
    grades: t(r?.[2]), tests_and_deadlines: t(r?.[3]), task_updates: t(r?.[4]),
    concern_category: t(r?.[5]), concern_text: t(r?.[6]), self_rating: t(r?.[7]),
    response_preference: t(r?.[8]), agenda: t(r?.[9]), routing_reason: t(r?.[10]),
  }));
  ingest(aaron, 'aaron', 9, (r) => ({
    task_updates: t(r?.[2]), upcoming_deadlines: t(r?.[3]), concern_category: t(r?.[4]),
    concern_text: t(r?.[5]), response_preference: t(r?.[6]), agenda: t(r?.[7]), routing_reason: t(r?.[8]),
  }));

  const byInstr = { ryan: records.filter((r) => r.instructor === 'ryan').length, aaron: records.filter((r) => r.instructor === 'aaron').length };
  console.log(`Resolved ${records.length} checkins (ryan ${byInstr.ryan}, aaron ${byInstr.aaron}); ${subsetHits.length} via subset-match (${[...new Set(subsetHits)].join(', ')}); ${warns.length} unmatched skipped.`);
  records.slice(0, 8).forEach((r) => console.log(`  ${r.instructor.padEnd(6)} ${String(r.submitted_at).slice(0, 10)} gate=${String(r.gate_state).padEnd(8)} ${r.student_sheet_id.slice(0, 10)}…`));
  warns.slice(0, 15).forEach((w) => console.log(`  ⚠ ${w}`));

  if (!WRITE) { console.log('\nDRY RUN — re-run with --write.'); return; }
  await sb.from('checkins').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  for (let i = 0; i < records.length; i += 500) {
    const { error } = await sb.from('checkins').insert(records.slice(i, i + 500));
    if (error) { console.error('insert failed:', error.message); process.exit(1); }
  }
  console.log(`\n✓ Inserted ${records.length} checkins (table cleared first).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
