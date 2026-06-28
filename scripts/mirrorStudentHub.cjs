/**
 * mirrorStudentHub.cjs — LIVE-SAFE Students-tab mirror (Sheets → Supabase).
 *
 *   node scripts/mirrorStudentHub.cjs                 # DRY RUN (read + report, no write)
 *   node scripts/mirrorStudentHub.cjs --write         # upsert student_profiles + meetings
 *   node scripts/mirrorStudentHub.cjs --limit 1       # first student only (quick check)
 *
 * Mirrors, per ACTIVE student, two things the new Students-tab hub needs that the
 * Master tab can't give:
 *   • intended major — 🔎 Overview!C6 ("Major/Path") → student_profiles.major
 *   • meeting agenda — the 📆 Meetings grid          → meetings (row-for-row, seq-keyed)
 *
 * One batchGet per student (Overview!C6 + Meetings!A1:H400), so ~1 Sheets read
 * per student. Read-only against Sheets; UPSERTS into Supabase (no delete window),
 * then prunes only rows for students it SUCCESSFULLY read this run. Idempotent.
 *
 * GUARDRAIL: this NEVER writes back to the 📆 Meetings sheet. The live student
 * "This week with <instructor>" card reads the SHEET (not this table), so this
 * mirror cannot clobber it. See supabase/students_hub_schema.sql + the plan.
 *
 * Requires supabase/students_hub_schema.sql applied and .env.local present.
 * Deploy: a heavy step of the reconcile cron (see scripts/reconcile.cjs). Reads
 * the active-student list from the `students` table (same source as reconcileScores).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const ZONE = 'America/Los_Angeles';
const OVERVIEW_MAJOR = "'🔎 Overview'!C6";
const MEETINGS_RANGE = "'📆 Meetings'!A1:H400";
const QUOTA_USER = 'mirror-student-hub';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

// 📆 dates are M/d/yy ("4/28/23") or M/d/yyyy ("4/2/2024") per the cell's date
// format — most older logs are 2-digit. Kept in LOCKSTEP with lib/collegeList.js
// parseMeetingDate (this .cjs script can't import the ESM lib). M/d/yyyy alone
// returned null on every 2-digit date (~69% of rows blanked).
const parseMeetingDate = (raw) => {
  for (const fmt of ['M/d/yyyy', 'M/d/yy']) {
    const dt = DateTime.fromFormat(raw, fmt, { zone: ZONE });
    if (dt.isValid) return dt;
  }
  return null;
};

// "100%"/"79%"/"0.79" → "79%" display string. Rejects → null: blanks, "#N/A"/"N/A"/
// "#REF!" (non-numeric), and date serials that landed in a percent-formatted cell
// (render as e.g. "4530000%" = serial 45300 — far past any real 0..1 progress value).
const normPct = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const n = Number(s.replace('%', ''));
  if (Number.isNaN(n)) return null;
  const f = s.includes('%') ? n / 100 : n;
  if (f < 0 || f > 2) return null;
  return `${Math.round(f * 100)}%`;
};

// Parse the 📆 Meetings values grid into rows, mirroring lib/collegeList.js
// parseMeetingsGrid (header at col B == "Date"; stop at the first empty date;
// hw_status lowercased; columns Date|Teacher|Project|Agenda|Homework|HW|%). Dates
// use the shared parseMeetingDate (M/d/yy + M/d/yyyy); pct is normalized to a clean
// "NN%" display string via normPct (the table column is text; the hub doesn't math
// on it) where parseMeetingsGrid returns a 0..1 fraction for its numeric consumer.
// `seq` is the row ordinal so upsert/prune is stable.
function meetingRowsFor(studentSheetId, values) {
  const rows = values || [];
  let hdr = -1;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]?.[1] ?? '').trim().toLowerCase() === 'date') {
      hdr = i;
      break;
    }
  }
  if (hdr < 0) return [];
  const out = [];
  let seq = 0;
  for (let i = hdr + 1; i < rows.length; i++) {
    const c = rows[i] || [];
    const rawDate = clean(c[1]);
    if (!rawDate) break; // contiguous log — first blank date ends it
    const dt = parseMeetingDate(rawDate);
    out.push({
      student_sheet_id: studentSheetId,
      seq: seq++,
      meeting_date: dt ? dt.toISODate() : null,
      teacher: clean(c[2]),
      project: clean(c[3]),
      agenda: clean(c[4]),
      homework: clean(c[5]),
      hw_status: clean(c[6]) ? String(c[6]).trim().toLowerCase() : null,
      pct: normPct(c[7]),
    });
  }
  return out;
}

async function main() {
  const WRITE = process.argv.includes('--write');
  const limIdx = process.argv.indexOf('--limit');
  const LIMIT = limIdx >= 0 ? Number(process.argv[limIdx + 1]) : Infinity;

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

  const { data: students, error } = await sb
    .from('students')
    .select('student_sheet_id, name')
    .eq('status', 'active')
    .order('name');
  if (error) throw error;

  const profiles = [];
  const allMeetings = [];
  const readIds = new Set();
  let withMajor = 0;
  let processed = 0;

  for (const s of students) {
    if (processed >= LIMIT) break;
    processed++;
    try {
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: s.student_sheet_id,
        ranges: [OVERVIEW_MAJOR, MEETINGS_RANGE],
        quotaUser: QUOTA_USER,
      });
      const ranges = res.data.valueRanges || [];
      const major = clean(ranges[0]?.values?.[0]?.[0]);
      const meetings = meetingRowsFor(s.student_sheet_id, ranges[1]?.values || []);
      profiles.push({ student_sheet_id: s.student_sheet_id, major });
      allMeetings.push(...meetings);
      if (major) withMajor++;
      readIds.add(s.student_sheet_id);
    } catch (e) {
      // No Overview/Meetings tab or a transient failure — do NOT prune this one.
      console.warn(`  skip ${s.name} (${s.student_sheet_id}): ${e.message}`);
    }
    await sleep(60); // gentle pacing under the per-project quota ceiling
  }

  console.log(
    `Read ${readIds.size}/${Math.min(students.length, LIMIT)} students · ` +
      `${withMajor} with a major · ${allMeetings.length} meeting rows.`
  );
  if (!WRITE) {
    console.log('DRY RUN — re-run with --write to upsert.');
    if (profiles.length) console.log('  sample profile:', JSON.stringify(profiles[0]));
    if (allMeetings.length) console.log('  sample meeting:', JSON.stringify(allMeetings[0]));
    return;
  }

  // ── student_profiles: upsert (no delete window) ────────────────────────────
  for (let i = 0; i < profiles.length; i += 500) {
    const { error: pErr } = await sb
      .from('student_profiles')
      .upsert(profiles.slice(i, i + 500), { onConflict: 'student_sheet_id' });
    if (pErr) {
      console.error('student_profiles upsert failed:', pErr.message);
      process.exit(1);
    }
  }
  console.log(`✓ Upserted ${profiles.length} student_profiles row(s).`);

  // ── meetings: upsert on (student_sheet_id, seq) ────────────────────────────
  for (let i = 0; i < allMeetings.length; i += 500) {
    const { error: mErr } = await sb
      .from('meetings')
      .upsert(allMeetings.slice(i, i + 500), { onConflict: 'student_sheet_id,seq' });
    if (mErr) {
      console.error('meetings upsert failed:', mErr.message);
      process.exit(1);
    }
  }
  console.log(`✓ Upserted ${allMeetings.length} meeting row(s) (live-safe, no delete window).`);

  // Prune trailing rows (a student whose log shrank): only for students read this
  // run, only seqs not present now. Current rows were upserted first, so the live
  // agenda is always complete during the prune.
  const currentKeys = new Set(allMeetings.map((m) => `${m.student_sheet_id}|${m.seq}`));
  const { data: existing, error: exErr } = await sb
    .from('meetings')
    .select('id, student_sheet_id, seq');
  if (exErr) {
    console.error('meetings prune-read failed:', exErr.message);
    process.exit(1);
  }
  const orphanIds = (existing || [])
    .filter((r) => readIds.has(r.student_sheet_id) && !currentKeys.has(`${r.student_sheet_id}|${r.seq}`))
    .map((r) => r.id);
  if (orphanIds.length) {
    for (let i = 0; i < orphanIds.length; i += 500) {
      const { error: dErr } = await sb.from('meetings').delete().in('id', orphanIds.slice(i, i + 500));
      if (dErr) {
        console.error('meetings prune failed:', dErr.message);
        process.exit(1);
      }
    }
    console.log(`✓ Pruned ${orphanIds.length} stale meeting row(s).`);
  } else {
    console.log('✓ No stale meeting rows to prune.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
