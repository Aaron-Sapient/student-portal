// Booking-token Supabase mirror (Bucket-A cutover; booking_tokens domain).
//
// The Master `👩‍🎓 All Data` sheet is the AUTHORITATIVE booking-token store —
// one cell per (student, instructor): AZ=ryan, BB=aaron, BD=art. This module
// keeps a best-effort Supabase mirror (`booking_tokens`, keyed on
// (student_sheet_id, instructor)) so the read side can eventually flip off
// Sheets. Every write here is NON-authoritative and NON-blocking: it must NEVER
// throw to a caller or abort the real Sheet write / booking. Reads stay on
// Sheets for now (no reader / read-flip yet), so a mirror miss is harmless.
//
// SENIORS and project meetings are NOT mirrored here — they have no Master token
// cell (their own Supabase ledgers are the authority). Callers already skip them
// before invoking these helpers, matching the authoritative Sheet-write guards.

import { getSupabaseClient, BOOKING_TOKENS } from './supabase';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';

// Parse a student's portal-doc id out of their Master col-G portal URL.
export function sheetIdFromPortalUrl(url) {
  const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

// Best-effort resolve of a student's sheetId from their Master row's col G, for
// the write sites that only know the 1-based `rowIndex` (they read J:J to locate
// the row). Deliberately a SEPARATE single-cell read rather than widening the
// authoritative J:J read — so the row-lookup that decides which student's token
// is written stays byte-for-byte unchanged. Returns null on any failure.
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
    console.warn('[dual-write:booking_tokens] sheetId resolve failed (mirror skipped):', e?.message || e);
    return null;
  }
}

// Mirror a single Master booking-token cell into Supabase, best-effort.
//   studentSheetId — the student's portal-doc id (FK into students)
//   slug           — 'ryan' | 'aaron' | 'art'
//   value          — the EXACT string just written to the Master cell.
//                    '' (cleared cell: ART cancel) removes the mirror row so no
//                    stale grantable token remains; ART's ISO instant is stored
//                    verbatim in token_value TEXT (byte-fidelity for the
//                    Saturday-reset comparison).
// token_value is the AUTHORITATIVE field a reader should key on; `consumed` is a
// ryan/aaron convenience (= value==='no') and is NOT meaningful for ART (an ISO
// stamp), 'pending', or 'written' — a future reader must not treat consumed=false
// as "bookable". Never throws — logs and returns on any failure.
export async function mirrorBookingToken({ studentSheetId, slug, value } = {}) {
  try {
    if (!studentSheetId || !slug) return; // unresolved student → reconcile backfills it
    const sb = getSupabaseClient();
    const v = String(value ?? '');

    if (v === '') {
      const { error } = await sb
        .from(BOOKING_TOKENS)
        .delete()
        .eq('student_sheet_id', studentSheetId)
        .eq('instructor', slug);
      if (error) console.warn('[dual-write:booking_tokens] delete failed (non-fatal):', error.message);
      return;
    }

    const { error } = await sb.from(BOOKING_TOKENS).upsert(
      {
        student_sheet_id: studentSheetId,
        instructor: slug,
        token_value: v,
        consumed: v.toLowerCase() === 'no',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'student_sheet_id,instructor' }
    );
    if (error) console.warn('[dual-write:booking_tokens] upsert failed (non-fatal):', error.message);
  } catch (e) {
    console.warn('[dual-write:booking_tokens] skipped (non-fatal):', e?.message || e);
  }
}
