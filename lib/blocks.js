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

// Reads all rows from the InstructorBlocks tab and returns them as objects.
// rowIndex is the 1-based sheet row (matches what the Sheets API uses for updates/deletes).
export async function listBlocks(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${BLOCKS_TAB}!A:E`,
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
  })).filter(b => b.instructor && b.startDate);
}

export async function addBlock(sheets, { instructor, startDate, endDate, reason }) {
  const createdAt = DateTime.now().setZone('America/Los_Angeles').toISO();
  await sheets.spreadsheets.values.append({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${BLOCKS_TAB}!A:E`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[instructor, startDate, endDate || startDate, reason || '', createdAt]] },
  });
}

// Clears the row's values rather than deleting the row outright — keeps rowIndex stable
// for any concurrent reads, and avoids needing the numeric sheetId for batchUpdate.
export async function deleteBlock(sheets, rowIndex) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${BLOCKS_TAB}!A${rowIndex}:E${rowIndex}`,
  });
}

export function isDateBlocked(blocks, instructorSlug, dateStr) {
  const target = DateTime.fromISO(dateStr, { zone: 'America/Los_Angeles' }).startOf('day');
  return blocks.some(b => {
    if (b.instructor.toLowerCase() !== instructorSlug.toLowerCase()) return false;
    const start = DateTime.fromISO(b.startDate, { zone: 'America/Los_Angeles' }).startOf('day');
    const end = DateTime.fromISO(b.endDate || b.startDate, { zone: 'America/Los_Angeles' }).startOf('day');
    return target >= start && target <= end;
  });
}
