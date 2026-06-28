/**
 * shadowCompareComps.cjs — parity check for the COMPS read cutover (Step B).
 *
 *   node scripts/shadowCompareComps.cjs
 *
 * For every active student it calls the ACTUAL app readers — getProjectRowsFromSheets
 * (authoritative '🏆 Comps & Projects'!E:N) and getProjectRowsFromSupabase
 * (`student_comps`, reconstructed into the same raw-rows shape) — then runs
 * activeProjectsFromRows on BOTH and diffs the consumed surface per project (keyed by
 * name): presence, owner, progress (number equality), and end date.
 *
 * Why the rendered surface, not raw cells: both readers feed the exact same
 * index-based parsers, and dates differ only by representation (Sheets serial vs PG
 * 'YYYY-MM-DD'), so end is normalized to an ISO calendar date before comparing — a
 * serial/ISO byte-diff is not a real mismatch (see lib/projects.js toLADate). It
 * imports the real reader functions (no reconstruction duplication ⇒ no drift).
 * Read-only against both systems.
 *
 * NOTE: this covers the home-card surface (activeProjectsFromRows). The looser
 * report/check-in prompt parsers (status ∈ {🟢,✅}) ride the SAME reconstructed rows,
 * so per spec their prompt text is spot-checked manually rather than byte-diffed here.
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

// endDate output is raw (Sheets serial number OR Supabase 'YYYY-MM-DD'); normalize
// both to an LA calendar date string so representation never reads as a mismatch.
function isoDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    const utc = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000), { zone: 'utc' });
    if (!utc.isValid) return null;
    return DateTime.fromObject({ year: utc.year, month: utc.month, day: utc.day }, { zone: ZONE }).toISODate();
  }
  const dt = DateTime.fromISO(String(raw), { zone: ZONE });
  return dt.isValid ? dt.toISODate() : null;
}

const norm = (p) => ({
  owner: p.owner ?? null,
  progress: typeof p.progress === 'number' ? p.progress : null,
  end: isoDate(p.endDate),
});

function diffActive(sheetActive, supaActive) {
  const diffs = [];
  const mapS = new Map(sheetActive.map((p) => [String(p.name ?? ''), norm(p)]));
  const mapU = new Map(supaActive.map((p) => [String(p.name ?? ''), norm(p)]));
  for (const k of mapS.keys()) if (!mapU.has(k)) diffs.push(`"${k}": in Sheets, missing in Supabase`);
  for (const k of mapU.keys()) if (!mapS.has(k)) diffs.push(`"${k}": in Supabase, missing in Sheets`);
  for (const [k, s] of mapS) {
    const u = mapU.get(k);
    if (!u) continue;
    if (s.owner !== u.owner) diffs.push(`"${k}" owner ${s.owner} (sheet) ≠ ${u.owner} (supa)`);
    if (s.progress !== u.progress) diffs.push(`"${k}" progress ${s.progress} (sheet) ≠ ${u.progress} (supa)`);
    if (s.end !== u.end) diffs.push(`"${k}" end ${s.end} (sheet) ≠ ${u.end} (supa)`);
  }
  return diffs;
}

async function main() {
  const get = loadEnv();
  // The app readers use getSupabaseClient(), which reads these from process.env.
  process.env.SUPABASE_URL = get('SUPABASE_URL');
  process.env.SUPABASE_SERVICE_ROLE_KEY = get('SUPABASE_SERVICE_ROLE_KEY');

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

  // The real app readers + the shared active filter — no reconstruction duplicated.
  const { getProjectRowsFromSheets, getProjectRowsFromSupabase, activeProjectsFromRows } = await import(
    '../lib/projects.js'
  );

  const { data: students, error: sErr } = await sb
    .from('students')
    .select('student_sheet_id, name')
    .eq('status', 'active')
    .order('name');
  if (sErr) throw sErr;

  let ok = 0;
  let mismatch = 0;
  let bothEmpty = 0;
  const problems = [];

  for (const s of students) {
    let sheetRows = [];
    try {
      sheetRows = await getProjectRowsFromSheets(sheets, s.student_sheet_id);
    } catch {
      sheetRows = []; // no 🏆 Comps & Projects tab
    }
    let supaRows = [[]];
    try {
      supaRows = await getProjectRowsFromSupabase(s.student_sheet_id);
    } catch (e) {
      problems.push({ name: s.name, id: s.student_sheet_id, diffs: [`supabase read threw: ${e.message}`] });
      mismatch++;
      continue;
    }

    const sheetActive = activeProjectsFromRows(sheetRows);
    const supaActive = activeProjectsFromRows(supaRows);

    if (sheetActive.length === 0 && supaActive.length === 0) {
      bothEmpty++;
      continue;
    }

    const diffs = diffActive(sheetActive, supaActive);
    if (diffs.length) {
      mismatch++;
      problems.push({ name: s.name, id: s.student_sheet_id, diffs });
    } else {
      ok++;
    }
  }

  console.log('\n── COMPS shadow parity (active projects; reconstructed rows feed the same parser) ──');
  console.log(`students checked: ${students.length}`);
  console.log(`  ✓ match:        ${ok}`);
  console.log(`  ✗ mismatch:     ${mismatch}`);
  console.log(`  · both empty:   ${bothEmpty} (no active projects either side)`);
  if (problems.length) {
    console.log('\nMismatches:');
    for (const p of problems) {
      console.log(`\n  ✗ ${p.name} (${p.id})`);
      p.diffs.slice(0, 12).forEach((d) => console.log(`      ${d}`));
      if (p.diffs.length > 12) console.log(`      … +${p.diffs.length - 12} more`);
    }
    process.exitCode = 1;
  } else {
    console.log('\n✓ Full parity — every active project matches between Sheets and Supabase.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
