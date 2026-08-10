/**
 * migrateBlocksToRanges.cjs — ONE-SHOT. Collapse instructor_blocks from one-row-per-date
 * into one-row-per-block (a date RANGE), using the Master Sheet's InstructorBlocks tab as
 * the authority for what the ranges actually were.
 *
 *   node scripts/migrateBlocksToRanges.cjs            # DRY RUN (read + verify + report)
 *   node scripts/migrateBlocksToRanges.cjs --write    # insert ranges, verify, delete old
 *
 * WHY THE SHEET IS THE AUTHORITY: recollapsing ranges out of the per-date rows would be
 * guesswork — adjacent same-reason days would merge and deliberate gaps would split. The
 * sheet still holds the original ranges verbatim, so we read them rather than infer them.
 *
 * ORDER OF OPERATIONS (each step exists for a reason):
 *   1. Capture the EXACT ids of every current row FIRST. After the end_date backfill, an
 *      old single-day row and a new single-day range row are identical in every column
 *      except id — there is no predicate that separates them, so the id list is the only
 *      safe delete key.
 *   2. INSERT the ranges before deleting anything, so no date is ever momentarily
 *      unblocked. Booking reads this table live.
 *   3. VERIFY from the database that the new rows reproduce the old rows' effective
 *      blocked surface exactly, and only then delete by the captured ids. A failure here
 *      leaves BOTH sets in place — over-blocking, never under-blocking. That is the safe
 *      direction to fail: a student sees fewer slots rather than booking into a block.
 *
 * Requires supabase/instructor_blocks.sql to have been applied first (end_date column).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const WRITE = process.argv.includes('--write');
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

// A Sheets date cell reads back as a serial (days since 1899-12-30) under
// UNFORMATTED_VALUE. The serial is a ZONELESS calendar day, so it must be rebuilt in
// UTC — rebuilding it in America/Los_Angeles lands on 17:00 the previous day and
// formats to the wrong date. (That exact bug shipped and was fixed in f29e12d.)
function normDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    const dt = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000), { zone: 'utc' });
    return dt.isValid ? dt.toFormat('yyyy-LL-dd') : null;
  }
  const dt = DateTime.fromISO(String(raw).trim(), { zone: ZONE });
  return dt.isValid ? dt.toFormat('yyyy-LL-dd') : null;
}

function normTime(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    const min = Math.round(raw * 24 * 60) % (24 * 60);
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  }
  const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

// The effective blocked surface: per (instructor, date), is the whole day blocked and
// which partial windows apply. This is the ONLY thing the booking consumers derive from
// this table, so it is the only thing the migration has to preserve. Comparing surfaces
// rather than row shapes is what lets a 1-row range be checked against 5 per-date rows.
function surfaceOf(rows) {
  const map = new Map();
  for (const r of rows) {
    const inst = String(r.instructor || '').toLowerCase();
    const partial = Boolean(r.start_time && r.end_time);
    let d = DateTime.fromISO(r.block_date, { zone: ZONE }).startOf('day');
    const last = DateTime.fromISO(r.end_date || r.block_date, { zone: ZONE }).startOf('day');
    if (!d.isValid || !last.isValid) continue;
    let n = 0;
    while (d <= last && n < 400) {
      const key = `${inst}|${d.toFormat('yyyy-LL-dd')}`;
      let e = map.get(key);
      if (!e) map.set(key, (e = { fullDay: false, windows: [] }));
      if (partial) e.windows.push(`${String(r.start_time).slice(0, 5)}-${String(r.end_time).slice(0, 5)}`);
      else e.fullDay = true;
      d = d.plus({ days: 1 });
      n++;
    }
  }
  // Dedupe windows: two identical windows on a date filter exactly like one.
  for (const e of map.values()) e.windows = [...new Set(e.windows)].sort();
  return map;
}

function diffSurfaces(before, after) {
  const diffs = [];
  for (const k of before.keys()) if (!after.has(k)) diffs.push(`LOST ${k}`);
  for (const k of after.keys()) if (!before.has(k)) diffs.push(`EXTRA ${k}`);
  for (const [k, a] of before) {
    const b = after.get(k);
    if (!b) continue;
    if (a.fullDay !== b.fullDay) diffs.push(`fullDay@${k} ${a.fullDay}→${b.fullDay}`);
    if (a.windows.join(',') !== b.windows.join(','))
      diffs.push(`windows@${k} [${a.windows}]→[${b.windows}]`);
  }
  return diffs;
}

async function main() {
  const g = loadEnv();
  const sb = createClient(
    g('NEXT_PUBLIC_SUPABASE_URL') || g('SUPABASE_URL'),
    g('SUPABASE_SERVICE_ROLE_KEY') || g('SUPABASE_SERVICE_KEY'),
    { auth: { persistSession: false } }
  );
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: g('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: (g('GOOGLE_PRIVATE_KEY') || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── Read the authoritative ranges from the sheet ───────────────────────────
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${TAB}!A:G`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const warnings = [];
  const ranges = [];
  for (const [i, r] of (res.data.values || []).slice(1).entries()) {
    const instructor = String(r[0] || '').trim().toLowerCase();
    const startDate = normDate(r[1]);
    // Deleted blocks are CLEARED, not row-deleted (lib/blocks.js deleteBlock), so the tab
    // is full of blank rows. Filter exactly as listBlocks does: instructor AND startDate.
    if (!instructor || !startDate) continue;
    if (!['aaron', 'ryan'].includes(instructor)) {
      warnings.push(`row ${i + 2}: instructor "${instructor}" is not aaron/ryan — SKIPPED`);
      continue;
    }
    const endDate = normDate(r[2]) || startDate;
    const st = normTime(r[5]);
    const et = normTime(r[6]);
    if (Boolean(st) !== Boolean(et)) {
      warnings.push(`row ${i + 2}: half-set time window (${st}/${et}) — treating as full-day`);
    }
    ranges.push({
      instructor,
      block_date: startDate,
      end_date: endDate < startDate ? startDate : endDate,
      start_time: st && et ? st : null,
      end_time: st && et ? et : null,
      reason: String(r[3] || '').trim() || null,
    });
    if (endDate < startDate) warnings.push(`row ${i + 2}: endDate < startDate — clamped to startDate`);
  }

  // ── Capture existing rows + ids BEFORE touching anything ────────────────────
  const { data: existing, error: exErr } = await sb
    .from('instructor_blocks')
    .select('id, instructor, block_date, end_date, start_time, end_time, reason');
  if (exErr) throw new Error(`read failed: ${exErr.message}`);
  const oldIds = existing.map((r) => r.id);

  // SELF-DISARM. This script treats the (now frozen) sheet as authoritative and replaces
  // the table's entire contents with it. That was correct exactly once. Run again after
  // the cutover and it would destroy every block created through the portal, with no
  // sheet copy to recover from. A migrated table contains at least one true multi-day
  // range, which a per-date table never did — use that as the tripwire.
  if (existing.some((r) => r.end_date && r.end_date > r.block_date)) {
    console.error(
      '✗ REFUSING TO RUN — instructor_blocks already holds multi-day ranges, so this\n' +
        '  migration has already been applied. The sheet is frozen and is NO LONGER the\n' +
        '  source of truth; re-running would replace app-created blocks with stale data.'
    );
    process.exit(1);
  }

  const before = surfaceOf(existing);
  const afterPlanned = surfaceOf(ranges);
  const planDiffs = diffSurfaces(before, afterPlanned);

  console.log(`Sheet ranges:        ${ranges.length}`);
  console.log(`Existing DB rows:    ${existing.length}  (ids captured for delete)`);
  console.log(`Effective surface:   ${before.size} (instructor,date) keys → ${afterPlanned.size} after`);
  warnings.forEach((w) => console.log(`  ⚠ ${w}`));

  if (planDiffs.length) {
    console.error(`\n✗ ABORT — the ranges do NOT reproduce the current blocked surface:`);
    planDiffs.slice(0, 40).forEach((d) => console.error(`    ${d}`));
    process.exit(1);
  }
  console.log(`\n✓ Planned ranges reproduce the current blocked surface exactly.`);

  if (!WRITE) {
    console.log('\nDRY RUN — re-run with --write to apply.');
    return;
  }

  // ── Insert ranges FIRST (never a gap in coverage) ───────────────────────────
  const { data: inserted, error: insErr } = await sb.from('instructor_blocks').insert(ranges).select('id');
  if (insErr) throw new Error(`insert failed: ${insErr.message}`);
  console.log(`\n+ Inserted ${inserted.length} range rows.`);

  // ── Re-verify FROM THE DATABASE, not from the plan ─────────────────────────
  const { data: newRows, error: nErr } = await sb
    .from('instructor_blocks')
    .select('id, instructor, block_date, end_date, start_time, end_time')
    .in('id', inserted.map((r) => r.id));
  if (nErr) throw new Error(`verify read failed: ${nErr.message}`);
  const confirmDiffs = diffSurfaces(before, surfaceOf(newRows));
  if (confirmDiffs.length) {
    console.error(`\n✗ POST-INSERT VERIFY FAILED — leaving BOTH row sets in place (over-blocks, never under-blocks).`);
    console.error(`  Old rows are untouched; delete nothing by hand until this is understood.`);
    confirmDiffs.slice(0, 40).forEach((d) => console.error(`    ${d}`));
    process.exit(1);
  }
  console.log(`✓ Verified from the DB: the ${newRows.length} new rows reproduce all ${before.size} blocked keys.`);

  // ── Only now delete the old per-date rows, by captured id ──────────────────
  for (let i = 0; i < oldIds.length; i += 500) {
    const { error } = await sb.from('instructor_blocks').delete().in('id', oldIds.slice(i, i + 500));
    if (error) throw new Error(`delete failed: ${error.message}`);
  }
  console.log(`- Deleted ${oldIds.length} old per-date rows by captured id.`);
  console.log(`\n✓ Migration complete: ${ranges.length} range rows are now the sole content.`);
}

main().catch((e) => {
  console.error('MIGRATION ERROR:', e.message);
  process.exit(1);
});
