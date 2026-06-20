/**
 * backfillPerStudent.cjs — per-student backfill of `scores`, `transcript_entries`,
 * `meetings_log`, and `students.grade`, reading each student's OWN spreadsheet
 * (student_sheet_id) in ONE batchGet per student (4 ranges). Paced + a dedicated
 * quotaUser so it never starves the live app's Sheets quota.
 *
 *   node scripts/backfillPerStudent.cjs           # DRY RUN (summary only)
 *   node scripts/backfillPerStudent.cjs --write    # clear+insert + update grade
 *
 * Mappings VERIFIED 2026-06-20 (agents + a live transcript probe):
 *  scores  '📊 Scores'!A2:I400 — v2: A date·B acad·C ec·D leadership·E overall·
 *    F insight·G coach·H rubricVer·I model; v1 (r[6]==='v1'): no leadership,
 *    D=overall, E=insight, F=coach, G='v1', H=model (lib/scores.js:83-108). RAW.
 *  transcript '🎓 Transcript'!A1:V40 — two side-by-side blocks: 9th rows 6-15 &
 *    10th rows 24-33 in cols E/F/G/H/K; 11th rows 6-15 & 12th rows 24-33 in cols
 *    P/Q/R/S/V (class/weighted/ap/sem1/sem2). Skip rows with empty class.
 *  meetings '📆 Meetings'!A1:H400 — header "Date" in col B(1); then c1 date
 *    (M/d/yyyy)·c2 teacher·c3 project·c4 agenda·c5 homework·c6 hwStatus·c7 pct.
 *  grade  '🔎 Overview'!C4 (e.g. "12th").
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const QUOTA_USER = 'backfill-perstudent';
const PACE_MS = 1100;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const TBLOCKS = [
  { grade: 9, lo: 6, hi: 15, cls: 4, wt: 5, ap: 6, s1: 7, s2: 10 },
  { grade: 10, lo: 24, hi: 33, cls: 4, wt: 5, ap: 6, s1: 7, s2: 10 },
  { grade: 11, lo: 6, hi: 15, cls: 15, wt: 16, ap: 17, s1: 18, s2: 21 },
  { grade: 12, lo: 24, hi: 33, cls: 15, wt: 16, ap: 17, s1: 18, s2: 21 },
];

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = (v) => { const s = String(v ?? '').trim(); return s || null; };
const num = (v) => { const s = String(v ?? '').trim(); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const bool = (v) => v === true || String(v ?? '').trim().toUpperCase() === 'TRUE';
function scoreDate(v) { const s = String(v ?? '').trim(); const m = s.match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1]; const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
function mdyToISO(v) { const m = String(v ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (!m) return null; return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }

function parseScores(rows) {
  const byDate = new Map();
  for (const r of rows || []) {
    const d = scoreDate(r?.[0]); if (!d) continue;
    const v1 = String(r?.[6] ?? '').trim() === 'v1';
    byDate.set(d, {
      scored_date: d, academic: num(r?.[1]), ec: num(r?.[2]),
      leadership: v1 ? null : num(r?.[3]), overall: v1 ? num(r?.[3]) : num(r?.[4]),
      insight: t(v1 ? r?.[4] : r?.[5]), coach_note: t(v1 ? r?.[5] : r?.[6]),
      rubric_ver: t(v1 ? r?.[6] : r?.[7]), model: t(v1 ? r?.[7] : r?.[8]),
    });
  }
  return [...byDate.values()];
}
function parseTranscript(rows) {
  const out = [];
  for (const b of TBLOCKS) {
    let ord = 0;
    for (let row = b.lo; row <= b.hi; row++) {
      const r = rows?.[row - 1] || [];
      const course = t(r[b.cls]); if (!course) continue;
      out.push({ grade_level: b.grade, ordinal: ord++, course, weighted: bool(r[b.wt]), is_ap: bool(r[b.ap]), sem1_grade: t(r[b.s1]), sem2_grade: t(r[b.s2]) });
    }
  }
  return out;
}
function parseMeetings(rows) {
  const out = [];
  let started = false;
  for (const r of rows || []) {
    if (!started) { if (String(r?.[1] ?? '').trim().toLowerCase() === 'date') started = true; continue; }
    const md = mdyToISO(r?.[1]); if (!md) { if (!String(r?.[1] ?? '').trim()) break; continue; }
    const notes = [['project', r?.[3]], ['agenda', r?.[4]], ['homework', r?.[5]], ['hwStatus', r?.[6]], ['pct', r?.[7]]]
      .filter(([, v]) => String(v ?? '').trim()).map(([k, v]) => `${k}: ${String(v).trim()}`).join(' · ') || null;
    out.push({ meeting_date: md, instructor: t(r?.[2]), notes });
  }
  return out;
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

  const { data: students, error } = await sb.from('students').select('student_sheet_id, name').order('name');
  if (error) { console.error(error.message); process.exit(1); }

  const RANGES = ["'📊 Scores'!A2:I400", "'🎓 Transcript'!A1:V40", "'📆 Meetings'!A1:H400", "'🔎 Overview'!B2:C4"];
  const allScores = [], allTranscript = [], allMeetings = [], gradeUpdates = [];
  const perStudent = [];
  const failures = [];

  for (const s of students) {
    let vr;
    try {
      vr = (await sheets.spreadsheets.values.batchGet({ spreadsheetId: s.student_sheet_id, ranges: RANGES, quotaUser: QUOTA_USER })).data.valueRanges;
    } catch (e) {
      // fall back to per-range reads (handles a missing tab)
      vr = [];
      for (const range of RANGES) {
        try { vr.push((await sheets.spreadsheets.values.get({ spreadsheetId: s.student_sheet_id, range, quotaUser: QUOTA_USER })).data); }
        catch { vr.push({ values: [] }); }
        await sleep(200);
      }
    }
    const [scR, trR, mtR, ovR] = vr.map((v) => (v && v.values) || []);
    const sc = parseScores(scR).map((x) => ({ ...x, student_sheet_id: s.student_sheet_id }));
    const tr = parseTranscript(trR).map((x) => ({ ...x, student_sheet_id: s.student_sheet_id }));
    const mt = parseMeetings(mtR).map((x) => ({ ...x, student_sheet_id: s.student_sheet_id }));
    const grade = t(ovR?.[2]?.[1]);
    allScores.push(...sc); allTranscript.push(...tr); allMeetings.push(...mt);
    if (grade) gradeUpdates.push({ id: s.student_sheet_id, grade });
    perStudent.push(`  ${s.name.padEnd(22)} scores:${String(sc.length).padStart(2)} courses:${String(tr.length).padStart(2)} meetings:${String(mt.length).padStart(2)} grade:${grade || '—'}`);
    if (!sc.length && !tr.length && !mt.length && !grade) failures.push(s.name);
    await sleep(PACE_MS);
  }

  console.log(perStudent.join('\n'));
  console.log(`\nTotals: scores ${allScores.length}, transcript_entries ${allTranscript.length}, meetings_log ${allMeetings.length}, grades ${gradeUpdates.length}/${students.length}.`);
  if (failures.length) console.log(`⚠ ${failures.length} student(s) returned NOTHING (check tabs): ${failures.join(', ')}`);

  if (!WRITE) { console.log('\nDRY RUN — re-run with --write.'); return; }
  for (const tbl of ['scores', 'transcript_entries', 'meetings_log']) {
    await sb.from(tbl).delete().neq('id', ZERO_UUID);
  }
  const bulk = async (tbl, rows) => {
    for (let i = 0; i < rows.length; i += 500) {
      const { error: e } = await sb.from(tbl).insert(rows.slice(i, i + 500));
      if (e) { console.error(`${tbl} insert failed:`, e.message); process.exit(1); }
    }
  };
  await bulk('scores', allScores);
  await bulk('transcript_entries', allTranscript);
  await bulk('meetings_log', allMeetings);
  for (const g of gradeUpdates) { await sb.from('students').update({ grade: g.grade }).eq('student_sheet_id', g.id); }
  console.log(`\n✓ Inserted scores ${allScores.length}, transcript ${allTranscript.length}, meetings ${allMeetings.length}; updated ${gradeUpdates.length} grades.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
