/**
 * shadowCompareInstructorBlocks.cjs — parity check for the BLOCKS read cutover.
 *
 *   node scripts/shadowCompareInstructorBlocks.cjs
 *
 * Reads the authoritative Sheets `InstructorBlocks` tab AND the Supabase
 * `instructor_blocks` table, then expands BOTH to the EFFECTIVE blocked surface
 * the four booking consumers actually compute: a Map keyed 'instructor|YYYY-MM-DD'
 * → { fullDay: bool, windows: sorted ['HH:mm-HH:mm'] }. Diffing those maps proves
 * isDateBlocked AND blockedWindowsForDate agree for every (instructor, date) — the
 * only thing consumers derive from listBlocks. Same altitude as
 * shadowCompareScores comparing raw inputs to the shared transform.
 *
 * Why per-date expansion: Sheets rows are date RANGES [startDate..endDate];
 * instructor_blocks stores one row PER DATE. Expanding both to per-date entries
 * makes them directly comparable AND asserts endpoint parity (first AND last day
 * of every range), which is the key temporal edge (inclusive expansion). Read-only
 * against both systems.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const TAB = 'InstructorBlocks';
const ZONE = 'America/Los_Angeles';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

// Mirror lib/blocks.js normalizeDate / normalizeTime exactly (UNFORMATTED reads
// come back as serial numbers or strings).
function normalizeDate(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'number') {
    const dt = DateTime.fromMillis((raw - 25569) * 86400 * 1000, { zone: ZONE });
    return dt.isValid ? dt.toFormat('yyyy-LL-dd') : '';
  }
  const dt = DateTime.fromISO(String(raw), { zone: ZONE });
  return dt.isValid ? dt.toFormat('yyyy-LL-dd') : String(raw);
}
function normalizeTime(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'number') {
    const totalMin = Math.round(raw * 24 * 60) % (24 * 60);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

// Postgres `time` → 'HH:mm'|'' (mirror lib/blocks.js hhmm).
const hhmm = (t) => (t ? String(t).slice(0, 5) : '');

// Add one block (range or single date) to the canonical effective-surface map.
// instructor is lower-cased exactly as isDateBlocked compares it (no trim).
function addRange(map, instructorRaw, startDate, endDate, startTime, endTime) {
  const inst = String(instructorRaw || '').toLowerCase();
  const isPartial = Boolean(startTime && endTime);
  let d = DateTime.fromISO(startDate, { zone: ZONE }).startOf('day');
  const last = DateTime.fromISO(endDate || startDate, { zone: ZONE }).startOf('day');
  if (!d.isValid || !last.isValid) return;
  let n = 0;
  while (d <= last && n < 400) {
    const key = `${inst}|${d.toFormat('yyyy-LL-dd')}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { fullDay: false, windows: [] };
      map.set(key, entry);
    }
    if (isPartial) entry.windows.push(`${startTime}-${endTime}`);
    else entry.fullDay = true;
    d = d.plus({ days: 1 });
    n++;
  }
}

function canonFromSheet(values) {
  const map = new Map();
  for (const r of values || []) {
    const instructor = r?.[0] || ''; // mirror listBlocks: truthy raw instructor
    const startDate = normalizeDate(r?.[1]);
    if (!instructor || !startDate) continue; // mirror listBlocks .filter(b.instructor && b.startDate)
    addRange(map, instructor, startDate, normalizeDate(r?.[2]), normalizeTime(r?.[5]), normalizeTime(r?.[6]));
  }
  return map;
}

function canonFromSupa(rows) {
  const map = new Map();
  for (const row of rows || []) {
    addRange(map, row.instructor, row.block_date, row.block_date, hhmm(row.start_time), hhmm(row.end_time));
  }
  return map;
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

  const sheetVals =
    (
      await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `'${TAB}'!A2:G500`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
    ).data.values || [];

  const { data: supaRows, error } = await sb
    .from('instructor_blocks')
    .select('instructor, block_date, start_time, end_time');
  if (error) throw error;

  const sheetMap = canonFromSheet(sheetVals);
  const supaMap = canonFromSupa(supaRows);

  const diffs = [];
  for (const key of sheetMap.keys()) if (!supaMap.has(key)) diffs.push(`${key}: in Sheets, missing in Supabase`);
  for (const key of supaMap.keys()) if (!sheetMap.has(key)) diffs.push(`${key}: in Supabase, missing in Sheets`);
  for (const [key, a] of sheetMap) {
    const b = supaMap.get(key);
    if (!b) continue;
    if (a.fullDay !== b.fullDay) diffs.push(`${key}: fullDay ${a.fullDay} (sheet) ≠ ${b.fullDay} (supa)`);
    if (a.windows.join(',') !== b.windows.join(','))
      diffs.push(`${key}: windows [${a.windows}] (sheet) ≠ [${b.windows}] (supa)`);
  }

  // Per-slug coverage summary (incl. 'art', which should be empty on both sides
  // today — no ART rows exist; ART shares Aaron's calendar via the 'aaron' slug).
  const countFor = (map, slug) => [...map.keys()].filter((k) => k.startsWith(`${slug}|`)).length;

  console.log('\n── INSTRUCTOR_BLOCKS shadow parity (effective blocked surface per instructor|date) ──');
  console.log(`sheet dated entries: ${sheetMap.size}  ·  supa dated entries: ${supaMap.size}`);
  for (const slug of ['aaron', 'ryan', 'art']) {
    console.log(`  ${slug.padEnd(6)} sheet=${countFor(sheetMap, slug)}  supa=${countFor(supaMap, slug)}`);
  }

  if (diffs.length) {
    console.log(`\n  ✗ ${diffs.length} mismatch(es):`);
    diffs.slice(0, 40).forEach((d) => console.log(`      ${d}`));
    if (diffs.length > 40) console.log(`      … +${diffs.length - 40} more`);
    process.exitCode = 1;
  } else {
    console.log('\n✓ Full parity — every (instructor, date) blocked surface matches between Sheets and Supabase.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
