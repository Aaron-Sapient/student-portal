import { getSupabaseClient } from '@/lib/supabase'
import { readMode, logShadow } from '@/lib/readFlags'
import {
  hasRecentGrades,
  hasRecentGradesWith,
  looksLikeGrade,
  TRANSCRIPT_GRADE_RANGE,
} from '@/lib/gradeData'

// Flag-gated transcript "recency gate" reader — Shape 1 of the transcript domain
// (the data-sufficiency boolean that grays out a student's score dashboard and
// skips them in scoring). The OTHER two transcript shapes do NOT migrate and stay
// on Sheets by design: getUpdateFormData's class-list read is bound to a Sheet
// write-back coordinate (rowOffset) the compacted transcript_entries.ordinal can't
// reconstruct, and generateReport's AA:AD summer-coursework block has no mirror
// (institution/year — GAP #6).
//
// Both sources feed the SAME decision skeleton (gradeData.hasRecentGradesWith), so
// the answer is byte-identical by construction; only the per-slot probe differs.
// Returns the exact { enough, reason, grade } shape hasRecentGrades returns.
//
// Reads from Sheets, Supabase, or both per the `transcript` flag (lib/readFlags.js).
// Default `off` ⇒ Sheets, unchanged. `shadow` reads both, logs diffs, returns
// Sheets. `on` reads Supabase, falling back to Sheets on a read ERROR (the gate is
// a hot path — a Supabase blip must degrade to today's behavior, never 500 the
// dashboard; a clean empty result is authoritative).

// classStr MUST be the graduation Class string ("'27"), NOT the "12th" grade label
// (academicGrade parses the trailing 2 digits — "12th" silently yields null⇒enough).
async function gateFromSheets(sheets, studentSheetId, classStr, nowLA) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: studentSheetId,
    range: TRANSCRIPT_GRADE_RANGE,
  })
  return hasRecentGrades(res.data.values || [], classStr, nowLA)
}

async function gateFromSupabase(studentSheetId, classStr, nowLA) {
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from('transcript_entries')
    .select('grade_level, sem1_grade, sem2_grade')
    .eq('student_sheet_id', studentSheetId)
  if (error) throw new Error(`transcript gate failed: ${error.message}`)
  const entries = data || []
  // transcript_entries only holds rows whose course is non-empty, and 434 rows
  // carry a course with empty grades — so "a row exists" ≠ "a grade exists":
  // looksLikeGrade MUST gate the stored cell, mirroring slotHasGrade exactly.
  const probe = (grade, sem) =>
    entries.some(
      (e) => e.grade_level === grade && looksLikeGrade(sem === 'S2' ? e.sem2_grade : e.sem1_grade)
    )
  return hasRecentGradesWith(probe, classStr, nowLA)
}

function diffGate(a, b) {
  const diffs = []
  if (!a || !b) return ['null-result']
  for (const k of ['enough', 'reason', 'grade']) {
    if (String(a[k]) !== String(b[k])) diffs.push(`${k} ${a[k]}≠${b[k]}`)
  }
  return diffs
}

export async function studentGradeGate(sheets, studentSheetId, classStr, nowLA) {
  const mode = readMode('transcript')
  if (mode === 'on') {
    try {
      return await gateFromSupabase(studentSheetId, classStr, nowLA)
    } catch (e) {
      console.warn(`[transcript:supabase] gate fell back to Sheets: ${e?.message}`)
      return gateFromSheets(sheets, studentSheetId, classStr, nowLA)
    }
  }
  if (mode === 'shadow') {
    const [sheetRes, supaRes] = await Promise.all([
      gateFromSheets(sheets, studentSheetId, classStr, nowLA),
      gateFromSupabase(studentSheetId, classStr, nowLA).catch((e) => {
        console.warn(`[shadow:transcript] ${studentSheetId} supabase read threw: ${e?.message}`)
        return null
      }),
    ])
    logShadow('transcript', studentSheetId, diffGate(sheetRes, supaRes))
    return sheetRes // shadow ALWAYS returns the authoritative Sheets answer
  }
  return gateFromSheets(sheets, studentSheetId, classStr, nowLA)
}
