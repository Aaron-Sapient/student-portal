// Authoritative booking-token store (Supabase `booking_tokens`).
//
// CUTOVER 2026-08-19 (SUMMER-EXIT.md W6): this table IS the booking-token
// authority for the ryan/aaron/art tracks — one row per (student, instructor),
// no row = no token. The Master-sheet AZ/BB/BD cells are no longer written or
// read by the app; any value still sitting in them is historical residue.
// Aaron's ruling: "a booking outcome should never live in the master sheet."
//
// SENIORS and project meetings are NOT stored here — they never had a token
// cell (their own Supabase ledgers are the authority). Callers already skip
// them before invoking these helpers.
//
// token_value vocabulary (TEXT, byte-preserved):
//   ryan  → '15min' | '30min' | 'written' | 'no' (consumed)
//   aaron → '15min' | '30min' | 'email'   | 'no' (consumed)
//   art   → ISO instant of the last booking (weekly Saturday-reset compare)
// `consumed` is a ryan/aaron convenience (= value === 'no') and is NOT
// meaningful for ART or 'written'/'email' — never treat consumed=false as
// "bookable"; token_value is what a reader keys on.

import { getSupabaseClient, BOOKING_TOKENS } from './supabase';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';

// Parse a student's portal-doc id out of their Master col-G portal URL.
export function sheetIdFromPortalUrl(url) {
  const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

// Resolve a student's sheetId from their Master row's col G, for write sites
// that only know the 1-based `rowIndex` (they read J:J to locate the row).
// Returns null on any failure — callers decide whether that's fatal.
export async function resolveStudentSheetId(sheets, rowIndex) {
  try {
    if (!(rowIndex > 0)) return null;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!G${rowIndex}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return sheetIdFromPortalUrl(res.data.values?.[0]?.[0]);
  } catch (e) {
    console.warn('[booking_tokens] sheetId resolve failed:', e?.message || e);
    return null;
  }
}

// Best-effort lookup of the student's native uuid key for the student_id
// column. Null (row written without it) is acceptable — student_sheet_id is
// the working key; student_id exists for joins against the native-key world.
async function resolveStudentId(sb, studentSheetId) {
  try {
    const { data } = await sb
      .from('students')
      .select('id')
      .eq('student_sheet_id', studentSheetId)
      .maybeSingle();
    return data?.id ?? null;
  } catch {
    return null;
  }
}

// AUTHORITATIVE write. Throws on failure — a token that fails to land is a
// broken grant/consume, not a cosmetic miss, so callers must not swallow it
// silently. '' deletes the row (cleared token, e.g. an ART cancel): no-row and
// no-token are the same state by construction.
export async function setBookingToken({ studentSheetId, slug, value }) {
  if (!studentSheetId || !slug) {
    throw new Error(`setBookingToken: missing key (studentSheetId=${studentSheetId}, slug=${slug})`);
  }
  const sb = getSupabaseClient();
  const v = String(value ?? '');

  if (v === '') {
    const { error } = await sb
      .from(BOOKING_TOKENS)
      .delete()
      .eq('student_sheet_id', studentSheetId)
      .eq('instructor', slug);
    if (error) throw new Error(`setBookingToken delete failed: ${error.message}`);
    return;
  }

  const studentId = await resolveStudentId(sb, studentSheetId);
  const { error } = await sb.from(BOOKING_TOKENS).upsert(
    {
      student_sheet_id: studentSheetId,
      instructor: slug,
      token_value: v,
      consumed: v.toLowerCase() === 'no',
      ...(studentId ? { student_id: studentId } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'student_sheet_id,instructor' }
  );
  if (error) throw new Error(`setBookingToken upsert failed: ${error.message}`);
}

// Reads one instructor's token value. '' = no token. Throws on a read error —
// the gate must fail closed and visible, never silently fall back to a stale
// source (there is no other source anymore).
export async function getBookingToken(studentSheetId, slug) {
  if (!studentSheetId) return '';
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from(BOOKING_TOKENS)
    .select('token_value')
    .eq('student_sheet_id', studentSheetId)
    .eq('instructor', slug)
    .maybeSingle();
  if (error) throw new Error(`getBookingToken(${slug}) failed: ${error.message}`);
  return data?.token_value ?? '';
}

// All of a student's tokens in one query, as { ryan, aaron, art } ('' = none).
// For read surfaces that render several tracks at once (home-data).
export async function getBookingTokens(studentSheetId) {
  const out = { ryan: '', aaron: '', art: '' };
  if (!studentSheetId) return out;
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from(BOOKING_TOKENS)
    .select('instructor, token_value')
    .eq('student_sheet_id', studentSheetId);
  if (error) throw new Error(`getBookingTokens failed: ${error.message}`);
  for (const row of data || []) {
    if (row.instructor in out) out[row.instructor] = row.token_value ?? '';
  }
  return out;
}
