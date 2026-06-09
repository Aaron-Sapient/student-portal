import { DateTime } from 'luxon';

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
