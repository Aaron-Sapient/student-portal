/**
 * shadowCompareColleges.cjs — parity check for the COLLEGES read cutover (Step B).
 *
 *   node scripts/shadowCompareColleges.cjs
 *
 * For every student it reads the authoritative 🏫 College List + 📆 Meetings from
 * their Google Sheet — via the app's OWN fetchCollegeDataFromSheets, so the parse
 * can't drift from production — AND the mirrored student_college_lists.payload from
 * Supabase, then runs the app's OWN diffCollegeData semantic comparator over the
 * fields the college + essay surfaces actually consume. Read-only against both.
 *
 * SEMANTIC, not byte: Postgres jsonb does not preserve object key order, so a raw
 * JSON.stringify compare would false-positive on every row even when identical.
 * diffCollegeData compares field-by-field on the consumed surface, EXACTLY like the
 * live shadow-mode log — same function, no second implementation to drift.
 *
 * Temporal edge baked in (per the "works 6 days, breaks Friday" lesson): a bare
 * "M/D" school deadline with no explicit year infers its cycle year from `now` at
 * parse time — the mirror bakes it at CRON time, the Sheets path at REQUEST time —
 * so the two legitimately diverge for ~15 min right after the April-1 cycle
 * boundary, before the reconcile re-runs. assertAprilBoundary() proves that
 * divergence is real (so the tolerance is justified) and that an explicit-year
 * deadline is boundary-stable; the main loop then tolerates ONLY deadline-field
 * diffs, and ONLY when the clock is within ~30 min of that boundary.
 *
 * Flip to 'on' only when this prints full parity AND auditSeniorCollegeLists.mjs
 * shows a mirror row for every senior with a usable list.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const ZONE = 'America/Los_Angeles';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

// Self-test the documented April-1 temporal edge so this parity check itself can't
// silently "work 6 days, break Friday": prove a bare-"M/D" fall deadline infers a
// DIFFERENT cycle year either side of the boundary (the source of the only tolerated
// diff), and that an explicit-year deadline is unaffected. Bails loudly if the
// parser's year inference ever changes out from under the tolerance logic below.
function assertAprilBoundary(parseDeadline) {
  const before = parseDeadline('11/1', DateTime.fromObject({ year: 2026, month: 3, day: 31 }, { zone: ZONE }));
  const after = parseDeadline('11/1', DateTime.fromObject({ year: 2026, month: 4, day: 1 }, { zone: ZONE }));
  const stableA = parseDeadline('11/1/2027', DateTime.fromObject({ year: 2026, month: 3, day: 31 }, { zone: ZONE }));
  const stableB = parseDeadline('11/1/2027', DateTime.fromObject({ year: 2026, month: 4, day: 1 }, { zone: ZONE }));
  const ok = before && after && before !== after && stableA === stableB && stableA === '2027-11-01';
  console.log(
    `April-1 edge self-test: bare "11/1" → ${before} (Mar) vs ${after} (Apr) [diverge: ${before !== after}] · ` +
      `explicit "11/1/2027" stable: ${stableA === stableB} → ${ok ? '✓' : '✗ FAILED'}`
  );
  if (!ok) {
    console.error('parseDeadline year inference changed — fix the tolerance window before trusting this run.');
    process.exit(1);
  }
}

// Are we within the ~15-min window (× slack) where mirror-vs-request deadline year
// inference legitimately disagrees? Only then is a deadline-only diff tolerated.
function nearAprilBoundary() {
  const now = DateTime.now().setZone(ZONE);
  const aprilFirst = DateTime.fromObject({ year: now.year, month: 4, day: 1 }, { zone: ZONE });
  return Math.abs(now.diff(aprilFirst, 'minutes').minutes) <= 30;
}

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

  // Reuse the app's OWN Sheets reader + comparator (no drift). The lib uses relative
  // imports, so this dynamic import resolves under plain node; fetchCollegeDataFromSheets
  // never touches Supabase, so it's independent of the read flag in this process.
  const { fetchCollegeDataFromSheets, diffCollegeData, parseDeadline } = await import(
    '../lib/collegeList.js'
  );

  assertAprilBoundary(parseDeadline);
  const tolerateDeadline = nearAprilBoundary();
  if (tolerateDeadline) {
    console.log('⏰ within ~30 min of the April-1 cycle boundary — deadline-only diffs will be TOLERATED.');
  }

  // Roster (active students) from the mirror — same source shadowCompareScores uses.
  const { data: students, error: stErr } = await sb
    .from('students')
    .select('student_sheet_id, name, status')
    .order('name');
  if (stErr) throw stErr;

  // All mirrored college lists in one read → sheetId → payload.
  const { data: lists, error: lErr } = await sb
    .from('student_college_lists')
    .select('student_sheet_id, payload');
  if (lErr) throw lErr;
  const supaById = new Map((lists || []).map((r) => [r.student_sheet_id, r.payload]));

  let ok = 0;
  let mismatch = 0;
  let tolerated = 0;
  let bothEmpty = 0;
  const problems = [];

  for (const s of students || []) {
    if (s.status === 'nc') continue; // NC students never get a college list mirrored
    let sheetPayload = null;
    try {
      sheetPayload = await fetchCollegeDataFromSheets(sheets, s.student_sheet_id);
    } catch {
      sheetPayload = null; // no college list / unreadable tab
    }
    const supaPayload = supaById.get(s.student_sheet_id) ?? null;

    if (!sheetPayload && !supaPayload) {
      bothEmpty++;
      continue;
    }

    const diffs = diffCollegeData(sheetPayload, supaPayload);
    if (!diffs.length) {
      ok++;
      continue;
    }

    // Tolerate ONLY when every diff is a deadline field AND we're in the boundary window.
    const deadlineOnly = diffs.every((d) => d.includes('.deadline '));
    if (deadlineOnly && tolerateDeadline) {
      tolerated++;
      continue;
    }

    mismatch++;
    problems.push({ name: s.name, id: s.student_sheet_id, diffs });
  }

  console.log('\n── COLLEGES shadow parity (semantic field-by-field; jsonb key order ignored) ──');
  console.log(`students checked: ${(students || []).filter((s) => s.status !== 'nc').length}`);
  console.log(`  ✓ match:        ${ok}`);
  console.log(`  ✗ mismatch:     ${mismatch}`);
  console.log(`  ⏰ tolerated:    ${tolerated} (deadline-only, near April-1 boundary)`);
  console.log(`  · both empty:   ${bothEmpty} (no college list either side)`);
  if (problems.length) {
    console.log('\nMismatches:');
    for (const p of problems) {
      console.log(`\n  ✗ ${p.name} (${p.id})`);
      p.diffs.slice(0, 12).forEach((d) => console.log(`      ${d}`));
      if (p.diffs.length > 12) console.log(`      … +${p.diffs.length - 12} more`);
    }
    process.exitCode = 1;
  } else {
    console.log('\n✓ Full parity — every college list matches between Sheets and Supabase.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
