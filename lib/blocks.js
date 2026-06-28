import { DateTime } from 'luxon';
import { getSupabaseClient } from '@/lib/supabase';
import { readMode, logShadow } from '@/lib/readFlags';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const BLOCKS_TAB = 'InstructorBlocks';

// Google Sheets auto-converts "YYYY-MM-DD" writes into date cells, which then
// read back as serial numbers (days since 1899-12-30) under UNFORMATTED_VALUE.
// This normalizes either a serial number or an ISO string back to "YYYY-MM-DD".
function normalizeDate(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'number') {
    const dt = DateTime.fromMillis((raw - 25569) * 86400 * 1000, { zone: 'America/Los_Angeles' });
    return dt.isValid ? dt.toFormat('yyyy-LL-dd') : '';
  }
  const dt = DateTime.fromISO(String(raw), { zone: 'America/Los_Angeles' });
  return dt.isValid ? dt.toFormat('yyyy-LL-dd') : String(raw);
}

// Times are written as "HH:mm", but Sheets may coerce them into a fraction-of-day
// serial number (0.5 = 12:00) that reads back as a number under UNFORMATTED_VALUE.
// Normalize either form back to "HH:mm". An empty value means "no time window" —
// i.e. a full-day block.
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

// Reads all rows from the InstructorBlocks tab and returns them as objects.
// rowIndex is the 1-based sheet row (matches what the Sheets API uses for updates/deletes).
// Columns F/G hold an optional time window; blank F/G means a full-day block.
export async function listBlocks(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${BLOCKS_TAB}!A:G`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  // Skip header row (row 1).
  return rows.slice(1).map((r, i) => ({
    rowIndex: i + 2,
    instructor: r[0] || '',
    startDate: normalizeDate(r[1]),
    endDate: normalizeDate(r[2]),
    reason: r[3] || '',
    createdAt: r[4] || '',
    startTime: normalizeTime(r[5]),
    endTime: normalizeTime(r[6]),
  })).filter(b => b.instructor && b.startDate);
}

export async function addBlock(sheets, { instructor, startDate, endDate, reason, startTime, endTime }) {
  const createdAt = DateTime.now().setZone('America/Los_Angeles').toISO();
  // A time window needs both ends; otherwise it's stored as a full-day block.
  const hasWindow = Boolean(startTime && endTime);
  const st = hasWindow ? startTime : '';
  const et = hasWindow ? endTime : '';
  await sheets.spreadsheets.values.append({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${BLOCKS_TAB}!A:G`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[instructor, startDate, endDate || startDate, reason || '', createdAt, st, et]] },
  });
}

// Clears the row's values rather than deleting the row outright — keeps rowIndex stable
// for any concurrent reads, and avoids needing the numeric sheetId for batchUpdate.
export async function deleteBlock(sheets, rowIndex) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${BLOCKS_TAB}!A${rowIndex}:G${rowIndex}`,
  });
}

// A date counts as fully blocked only by a full-day block (no time window). A
// partial-time block doesn't make the whole day unavailable — its window is merged
// into busy windows via blockedWindowsForDate so individual slots get filtered.
export function isDateBlocked(blocks, instructorSlug, dateStr) {
  const target = DateTime.fromISO(dateStr, { zone: 'America/Los_Angeles' }).startOf('day');
  return blocks.some(b => {
    if (b.instructor.toLowerCase() !== instructorSlug.toLowerCase()) return false;
    if (b.startTime && b.endTime) return false; // partial-time block, not full-day
    const start = DateTime.fromISO(b.startDate, { zone: 'America/Los_Angeles' }).startOf('day');
    const end = DateTime.fromISO(b.endDate || b.startDate, { zone: 'America/Los_Angeles' }).startOf('day');
    return target >= start && target <= end;
  });
}

// Returns busy windows ({ start, end } DateTimes) from partial-time blocks whose date
// range covers `dateStr`. The block's time window applies on each day in its range.
export function blockedWindowsForDate(blocks, instructorSlug, dateStr) {
  const zone = 'America/Los_Angeles';
  const target = DateTime.fromISO(dateStr, { zone }).startOf('day');
  const windows = [];
  for (const b of blocks) {
    if (b.instructor.toLowerCase() !== instructorSlug.toLowerCase()) continue;
    if (!b.startTime || !b.endTime) continue;
    const start = DateTime.fromISO(b.startDate, { zone }).startOf('day');
    const end = DateTime.fromISO(b.endDate || b.startDate, { zone }).startOf('day');
    if (target < start || target > end) continue;
    const [sh, sm] = b.startTime.split(':').map(Number);
    const [eh, em] = b.endTime.split(':').map(Number);
    windows.push({
      start: target.set({ hour: sh, minute: sm }),
      end: target.set({ hour: eh, minute: em }),
    });
  }
  return windows;
}

// ── Supabase reader (migration target — table `instructor_blocks`) ──────────
// instructor_blocks stores ONE row PER DATE (block_date, no end_date), the exact
// per-date expansion of each Sheets [startDate..endDate] range. That shape is
// what the booking predicates want: isDateBlocked does target>=start && target
// <=end and blockedWindowsForDate keys off the date, so a single-day row
// (startDate===endDate===block_date) yields IDENTICAL results to the original
// range for every consumer. We do NOT recollapse into ranges — that'd be lossy
// (adjacent same-reason days merge, gaps split) and buys nothing.
//
// Postgres `time` reads back as 'HH:MM:SS'; strip to 'HH:mm' so
// blockedWindowsForDate's split(':') stays byte-identical to Sheets
// normalizeTime, and a NULL time → '' (not null) to match the Sheets shape and
// the `b.startTime && b.endTime` truthiness gate. block_date arrives as a plain
// 'YYYY-MM-DD' string, fed straight to the existing DateTime.fromISO predicates.
// createdAt/reason are read by NO booking consumer, so '' for createdAt is safe.
function hhmm(t) {
  return t ? String(t).slice(0, 5) : '';
}

async function listBlocksFromSupabase() {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from('instructor_blocks')
    .select('instructor, block_date, start_time, end_time, reason')
    .order('instructor', { ascending: true })
    .order('block_date', { ascending: true });
  // THROW (not return []) on a read error so shadow mode logs it and the `on`
  // path surfaces it to the caller's existing `.catch(() => [])` — which yields
  // the SAME fail-open behavior the Sheets path already has when listBlocks
  // throws. (Blocks aren't auth-critical, so no Sheets fallback like identity.)
  if (error) throw new Error(`instructor_blocks query failed: ${error.message}`);
  return (data || []).map((row) => ({
    rowIndex: null, // Sheets coordinate; not reconstructible — devel route stays on Sheets
    instructor: row.instructor || '',
    startDate: row.block_date,
    endDate: row.block_date,
    reason: row.reason || '',
    createdAt: '',
    startTime: hhmm(row.start_time),
    endTime: hhmm(row.end_time),
  }));
}

// Collapse a block list to the EFFECTIVE surface the booking consumers compute:
// per (instructor, date), whether the whole day is blocked (isDateBlocked) and
// which partial busy windows apply (blockedWindowsForDate). Expanding Sheets
// ranges per-date here makes a range-shaped Sheets row directly comparable to
// the already-per-date Supabase rows. instructor is lower-cased exactly as
// isDateBlocked compares it (no trim), so a stray-whitespace divergence would
// surface rather than be masked. Keyed 'instructor|YYYY-MM-DD'.
function canonicalBlocks(blocks) {
  const zone = 'America/Los_Angeles';
  const map = new Map();
  for (const b of blocks) {
    const inst = String(b.instructor || '').toLowerCase();
    const isPartial = Boolean(b.startTime && b.endTime);
    let d = DateTime.fromISO(b.startDate, { zone }).startOf('day');
    const last = DateTime.fromISO(b.endDate || b.startDate, { zone }).startOf('day');
    if (!d.isValid || !last.isValid) continue;
    let n = 0;
    while (d <= last && n < 400) {
      const key = `${inst}|${d.toFormat('yyyy-LL-dd')}`;
      let entry = map.get(key);
      if (!entry) {
        entry = { fullDay: false, windows: [] };
        map.set(key, entry);
      }
      if (isPartial) entry.windows.push(`${b.startTime}-${b.endTime}`);
      else entry.fullDay = true;
      d = d.plus({ days: 1 });
      n++;
    }
  }
  for (const e of map.values()) e.windows.sort();
  return map;
}

// shadow comparator: diff strings (empty ⇒ match). Compares the effective
// blocked surface, not row shapes — the only thing the four booking consumers
// derive from listBlocks.
function diffBlocks(sheetBlocks, supaBlocks) {
  const diffs = [];
  const a = canonicalBlocks(sheetBlocks);
  const b = canonicalBlocks(supaBlocks);
  for (const key of a.keys()) if (!b.has(key)) diffs.push(`supa missing ${key}`);
  for (const key of b.keys()) if (!a.has(key)) diffs.push(`supa extra ${key}`);
  for (const [key, ea] of a) {
    const eb = b.get(key);
    if (!eb) continue;
    if (ea.fullDay !== eb.fullDay) diffs.push(`fullDay@${key} ${ea.fullDay}≠${eb.fullDay}`);
    if (ea.windows.join(',') !== eb.windows.join(','))
      diffs.push(`windows@${key} [${ea.windows}]≠[${eb.windows}]`);
  }
  return diffs;
}

// Booking-availability reader for instructor blocks, flag-gated on
// readMode('blocks'). Default `off` ⇒ delegate to the Sheets listBlocks() above
// (byte-identical to today). `shadow` reads both, logs the effective-surface
// diff, and returns the authoritative Sheets answer. `on` reads Supabase only.
//
// SCOPE: only the four booking consumers (getMonthAvailability, getAvailableSlots,
// submitUpdateForm, submitAaronUpdateForm) call THIS. The developer admin route
// keeps calling the plain listBlocks() — it both renders ranges AND is the write
// surface (addBlock/deleteBlock by rowIndex), and rowIndex is a Sheets coordinate
// that cannot be reconstructed from Supabase, so that surface can never cut over.
export async function listBlocksForBooking(sheets) {
  const mode = readMode('blocks');
  if (mode === 'on') return listBlocksFromSupabase();
  if (mode === 'shadow') {
    const [sheetBlocks, supaBlocks] = await Promise.all([
      listBlocks(sheets),
      listBlocksFromSupabase().catch((e) => {
        console.warn(`[shadow:blocks] supabase read threw: ${e?.message}`);
        return [];
      }),
    ]);
    logShadow('blocks', 'instructor_blocks', diffBlocks(sheetBlocks, supaBlocks));
    return sheetBlocks; // shadow ALWAYS returns the authoritative Sheets answer
  }
  return listBlocks(sheets);
}
