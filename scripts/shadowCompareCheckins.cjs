/**
 * shadowCompareCheckins.cjs — parity check for the CHECK-INS read cutover (domain
 * `checkins`), covering BOTH flag-governed dev surfaces:
 *
 *   node scripts/shadowCompareCheckins.cjs
 *
 *   (1) getCheckinTimeline — per student, the [{date,who}] tick list. Sheets joins
 *       the two Master form tabs by normalized form-name; Supabase reads the
 *       `checkins` mirror by student_sheet_id. Compared as sets of `date|who`.
 *   (2) readLatestCheckins — the Students-tab recency Map<normName,latestISO>.
 *       Sheets keys by form-name; Supabase keys by normName(students.name).
 *
 * Mirrors lib/checkins.js transforms EXACTLY:
 *   • Sheets date  = cellToISODate(serial)            (UNFORMATTED_VALUE → LA date)
 *   • Supabase date = utc-instant → LA → toISODate()  (the submitted_at timestamptz)
 * Read-only against both systems.
 *
 * EXPECTED, ACCEPTABLE diffs (name-join IMPROVEMENTS, not bugs — sign off, don't fix):
 *   - check-ins submitted under an aliased name (Seoah Baek = Victoria Baek) or a
 *     trailing-space form name ("Aasrith Dwarampudi ") resolve in Supabase (keyed by
 *     student_sheet_id at backfill) but were MISSED by the Sheets name-join.
 * MUST-INVESTIGATE-BEFORE-FLIP:
 *   - any DATE off-by-one (the utc→LA reconstruction disagreeing with the Sheets
 *     serial near midnight) — the #1 parity risk.
 *   - any student count mismatch beyond the enumerated name-join cases.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const ZONE = 'America/Los_Angeles';
const CHECKIN_TABS = [
  { tab: 'CheckinForm', who: 'Ryan' },
  { tab: 'A_CheckinForm', who: 'Aaron' },
];
const WHO = { ryan: 'Ryan', aaron: 'Aaron' };

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

// Mirror lib/checkins normName + shared.cellToISODate exactly.
const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
function cellToISODate(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!raw) return null;
    const dt = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000)).setZone(ZONE);
    return dt.isValid ? dt.toISODate() : null;
  }
  const s = String(raw).trim();
  if (!s || /^n\/?a$/i.test(s) || /^tbd$/i.test(s) || s === '-') return null;
  let dt = DateTime.fromISO(s, { zone: ZONE });
  if (!dt.isValid) {
    const js = new Date(s);
    if (!isNaN(js.getTime())) dt = DateTime.fromJSDate(js).setZone(ZONE);
  }
  return dt.isValid ? dt.toISODate() : null;
}
// Supabase submitted_at (UTC instant) → LA calendar date, like lib/checkins.js.
const supaDate = (ts) => {
  const dt = DateTime.fromISO(String(ts || ''), { zone: 'utc' }).setZone(ZONE);
  return dt.isValid ? dt.toISODate() : null;
};

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

  // ── Roster (sheetId → name), from the Supabase mirror ──────────────────────
  const { data: studs, error: stErr } = await sb
    .from('students')
    .select('student_sheet_id, name, status')
    .order('name');
  if (stErr) throw stErr;
  const students = (studs || []).filter((s) => s.student_sheet_id && String(s.name ?? '').trim());

  // ── Sheets side: ONE Master batchGet of both form tabs (UNFORMATTED_VALUE) ──
  const valueRanges = (await sheets.spreadsheets.values.batchGet({
    spreadsheetId: MASTER_SHEET_ID,
    ranges: CHECKIN_TABS.map((t) => `${t.tab}!A:B`),
    valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.valueRanges || [];
  // normName(formName) → [{date,who}]  +  normName(formName) → latestISO
  const sheetTimelineByName = new Map();
  const sheetLatestByName = new Map();
  valueRanges.forEach((vr, i) => {
    for (const r of (vr.values || []).slice(1)) {
      const key = normName(r?.[1]);
      if (!key) continue;
      const date = cellToISODate(r?.[0]);
      if (!date) continue;
      if (!sheetTimelineByName.has(key)) sheetTimelineByName.set(key, []);
      sheetTimelineByName.get(key).push({ date, who: CHECKIN_TABS[i].who });
      const prev = sheetLatestByName.get(key);
      if (!prev || date > prev) sheetLatestByName.set(key, date);
    }
  });

  // ── Supabase side: all `checkins` (+ joined student name) ──────────────────
  const { data: rows, error: ckErr } = await sb
    .from('checkins')
    .select('student_sheet_id, submitted_at, instructor, students(name)');
  if (ckErr) throw ckErr;
  const supaTimelineById = new Map(); // sheetId → [{date,who}]
  const supaLatestByName = new Map(); // normName(students.name) → latestISO
  for (const row of rows || []) {
    const date = supaDate(row.submitted_at);
    if (!date) continue;
    const who = WHO[row.instructor] || row.instructor;
    if (!supaTimelineById.has(row.student_sheet_id)) supaTimelineById.set(row.student_sheet_id, []);
    supaTimelineById.get(row.student_sheet_id).push({ date, who });
    const nk = normName(row.students?.name);
    if (nk) {
      const prev = supaLatestByName.get(nk);
      if (!prev || date > prev) supaLatestByName.set(nk, date);
    }
  }

  // ── (1) Per-student TIMELINE parity (Sheets by name vs Supabase by sheetId) ──
  const keyset = (arr) => new Set((arr || []).map((c) => `${c.date}|${c.who}`));
  let tlOk = 0;
  let tlBothEmpty = 0;
  const tlProblems = [];
  for (const s of students) {
    const sheetTl = sheetTimelineByName.get(normName(s.name)) || [];
    const supaTl = supaTimelineById.get(s.student_sheet_id) || [];
    if (!sheetTl.length && !supaTl.length) { tlBothEmpty++; continue; }
    const a = keyset(sheetTl);
    const b = keyset(supaTl);
    const diffs = [];
    for (const k of a) if (!b.has(k)) diffs.push(`sheets-only ${k}`);
    for (const k of b) if (!a.has(k)) diffs.push(`supa-only ${k}`);
    if (diffs.length) tlProblems.push({ name: s.name, id: s.student_sheet_id, diffs });
    else tlOk++;
  }

  // ── (2) readLatestCheckins MAP parity (both keyed by normName) ──────────────
  const latestDiffs = [];
  for (const [k, v] of sheetLatestByName) {
    const w = supaLatestByName.get(k);
    if (w === undefined) latestDiffs.push(`sheets-only ${k}=${v}`);
    else if (v !== w) latestDiffs.push(`${k} ${v}≠${w}`);
  }
  for (const [k, v] of supaLatestByName) {
    if (!sheetLatestByName.has(k)) latestDiffs.push(`supa-only ${k}=${v}`);
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log('\n── CHECK-INS shadow parity ──');
  console.log(`students checked: ${students.length}`);
  console.log('\n(1) per-student timeline ({date,who}):');
  console.log(`  ✓ match:      ${tlOk}`);
  console.log(`  ✗ mismatch:   ${tlProblems.length}`);
  console.log(`  · both empty: ${tlBothEmpty}`);
  if (tlProblems.length) {
    for (const p of tlProblems) {
      console.log(`\n  ✗ ${p.name} (${p.id})`);
      p.diffs.slice(0, 12).forEach((d) => console.log(`      ${d}`));
      if (p.diffs.length > 12) console.log(`      … +${p.diffs.length - 12} more`);
    }
  }
  console.log(`\n(2) readLatestCheckins map: sheets=${sheetLatestByName.size} supa=${supaLatestByName.size} · mismatches=${latestDiffs.length}`);
  if (latestDiffs.length) latestDiffs.forEach((d) => console.log(`      ✗ ${d}`));

  if (tlProblems.length || latestDiffs.length) {
    console.log('\nReview the diffs above: name-join cases (aliased/whitespace names — e.g. Seoah/Victoria Baek) are EXPECTED improvements; any DATE off-by-one is a BLOCKER.');
    process.exitCode = 1;
  } else {
    console.log('\n✓ Full parity — every timeline and the recency map match between Sheets and Supabase.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
