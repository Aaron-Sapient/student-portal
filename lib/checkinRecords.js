import { getSupabaseClient } from '@/lib/supabase'

// ============================================================================
// lib/checkinRecords.js — a submitted check-in's ONE home.
//
// Before the 2026-09-02 cutover a check-in was a row appended to a tab on the
// MASTER sheet (`CheckinForm` for Ryan, `A_CheckinForm` for Aaron), and the
// `checkins` table was a mirror the NAS reconcile cron re-derived from those tabs.
// The sheet was the record; Postgres was the copy. That is now inverted and the
// copy step is retired — these functions are the only writer, and the sheet tabs
// are frozen historical residue. Same retirement pattern as `booking_tokens`
// (2026-08-19) and `instructor_blocks` (2026-08-09): see scripts/reconcile.cjs.
//
// ⚠ THE PAYLOAD KEYS ARE A CONTRACT, not an internal shape. 353 rows written by
// scripts/backfillCheckins.cjs already use them, and every reader below joins
// across both eras. The two instructors have DIFFERENT key sets because their form
// tabs always did — do not "unify" them, that silently orphans one era's history.
//   ryan  : grades, tests_and_deadlines, task_updates, concern_category,
//           concern_text, self_rating, response_preference, agenda, routing_reason
//   aaron : task_updates, upcoming_deadlines, concern_category, concern_text,
//           response_preference, agenda, routing_reason
//
// ⚠ ROWS ARE JOINED BY student_sheet_id, NEVER BY NAME. The sheet era matched
// col B against 🔎 Overview!B2 and needed NAME_ALIASES plus trim-insensitive
// compares to survive live spelling divergence (Victoria/Seoah Baek, Vedant,
// Aasrith's trailing space). The FK retires that whole bug class.
// ============================================================================

// Record a submitted check-in. Returns the new row's uuid, which the caller uses
// to stamp the routing decision back onto THIS row (see setCheckinOutcome) rather
// than re-scanning for "the last row with my name on it".
//
// THROWS on failure. A check-in that does not land is a lost submission.
export async function recordCheckin({ studentSheetId, instructor, submittedAt, payload }) {
  if (!studentSheetId) throw new Error('recordCheckin: missing studentSheetId')
  const { data, error } = await getSupabaseClient()
    .from('checkins')
    .insert({
      student_sheet_id: studentSheetId,
      instructor,
      submitted_at: submittedAt,
      payload,
    })
    .select('id')
    .single()
  if (error) throw new Error(`recordCheckin(${instructor}) failed: ${error.message}`)
  return data.id
}

// Stamp the routing outcome on a check-in already recorded.
//   gate_state      ← the decision ('15min' | '30min' | 'written' | 'email' | 'no')
//   payload.routing_reason ← the evaluator's one-line rationale
// Was: re-read the whole form tab, find the LAST row whose col B matched this
// student's name, then batchUpdate cols K/L of that row number.
//
// Best-effort by design: the check-in and the booking token have both already
// landed, so a failure here loses an audit note, not a submission.
export async function setCheckinOutcome(checkinId, { decision, reason, existingPayload }) {
  if (!checkinId) return
  try {
    const { error } = await getSupabaseClient()
      .from('checkins')
      .update({
        gate_state: decision ?? null,
        payload: { ...(existingPayload || {}), routing_reason: reason || null },
      })
      .eq('id', checkinId)
    if (error) throw new Error(error.message)
  } catch (e) {
    console.warn(`[checkins] outcome stamp failed for ${checkinId}: ${e?.message}`)
  }
}

// The student's most recent check-ins for one instructor, NEWEST FIRST, as
// [{ id, submitted_at, payload }]. `excludeId` drops the submission that is
// mid-flight so a caller can ask for "the ones before this one".
export async function recentCheckins(studentSheetId, instructor, limit, excludeId = null) {
  if (!studentSheetId) return []
  const { data, error } = await getSupabaseClient()
    .from('checkins')
    .select('id, submitted_at, payload')
    .eq('student_sheet_id', studentSheetId)
    .eq('instructor', instructor)
    .order('submitted_at', { ascending: false })
    .limit(limit + (excludeId ? 1 : 0))
  if (error) throw new Error(`recentCheckins failed: ${error.message}`)
  return (data || []).filter((r) => r.id !== excludeId).slice(0, limit)
}
