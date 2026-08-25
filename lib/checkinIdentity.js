import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'

// ============================================================================
// lib/checkinIdentity.js — resolve WHICH STUDENT a check-in submission is for,
// server-side, from the Clerk session. Nothing about the write target may come
// from the request body.
//
// THE BUG THIS CLOSES. The check-in POST routes authenticated the session and
// then took `studentSheetId`, `studentRowIndex`, `studentName` and `gradesRange`
// straight off the request body, echoed back by the client from the matching GET.
// Nothing re-derived them. The service account holds spreadsheets scope over the
// Master and every student sheet, so any signed-in student or parent could name
// someone else's sheet, tab, column and rows — an arbitrary write primitive
// across the whole Sheets database, plus the ability to stamp another student's
// check-in columns, grant a booking token in their name, and trigger a grant
// email to their family. The GET side was always correct
// (app/api/getUpdateFormData/route.js resolved the row from the session email);
// only the POST trusted the client's echo.
//
// ⚠ THE NAME COMES FROM 🔎 Overview!B2, *NOT* MASTER COL A — and that is not a
// stylistic choice. The two disagree on live students, and every existing writer
// of a check-in row used the Overview name:
//   getUpdateFormData:64 · getAaronUpdateFormData:49 · validateBooking:68 · home-data
// Live divergences at the time of writing: master "Victoria Baek" / overview
// "Seoah Baek"; master "Vedant Narayansa" / overview "Vedant"; master "Aasrith
// Dwarampudi" / overview "Aasrith Dwarampudi " (trailing space). The repo already
// carries workarounds for exactly this: scripts/backfillCheckins.cjs:89's
// NAME_ALIASES, and lib/generateReport.js:188-192's trim-insensitive match, whose
// comment names the Aasrith case explicitly.
//
// Switching this to Master col A silently re-splits those students' histories:
// CheckinForm is matched by NAME (submitUpdateForm's grade-history filter,
// bookMeeting's agenda write target), so a new spelling stops matching the ~24
// existing rows — the grade-drop signal that feeds an unreviewed meeting-grant
// decision would read "None detected" forever, and bookMeeting would write this
// week's agenda onto a PRIOR week's row rather than failing loudly. A security fix
// must not carry a data-model change in its pocket. `rosterName` is returned
// alongside for callers that legitimately want the roster spelling; unifying the
// two is a separate, deliberate migration with a normalizer, not a side effect.
//
// WHY A SHARED RESOLVER RATHER THAN THREE INLINE PATCHES. The Google Drive
// cutover will rewrite these routes, and a mechanical port keeps whatever shape
// it finds: `studentSheetId` from the body becomes `student_id` from the body and
// the same bug ships against Postgres. A named resolver is the seam the ported
// routes inherit — its internals change, its contract and its callers do not.
//
// WHY A FRESH READ AND NOT loadMasterRows()'s CACHE. identity.js caches the
// roster with a TTL to protect the Sheets read quota, which is right for read
// paths. This one hands back a ROW INDEX used to write `AY${rowIndex}`. A cache
// stale across a row insert would land a student's check-in stamp on a different
// student's row — the exact silent cross-student corruption this file prevents.
// The reads go through getGoogleSheetsClient(email) so they land in the caller's
// own quotaUser bucket rather than the shared 60-reads/min one (lib/google.js).
// ============================================================================

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4'
const MASTER_TAB = '👩‍🎓 All Data'

export function getCurrentSemester() {
  const month = new Date().getMonth() + 1
  if (month >= 6 && month <= 8) return 'NA'
  if (month >= 9 && month <= 12) return 'S1'
  return 'S2'
}

// The transcript grid a given grade year + semester writes into. Moved here from
// app/api/getUpdateFormData so the POST can RECOMPUTE the range instead of
// accepting the client's copy of it — a body-supplied A1 range was half of the
// arbitrary-write primitive. Returns null for any grade year / semester without a
// grid; the GET's own skip-gate means null can never reach its destructure.
export function getGradeRanges(gradeYear, semester) {
  const gradeCol = {
    S1: { '9th': 'H', '10th': 'H', '11th': 'S', '12th': 'S' },
    S2: { '9th': 'K', '10th': 'K', '11th': 'V', '12th': 'V' },
  }
  const nameCol = { '9th': 'E', '10th': 'E', '11th': 'P', '12th': 'P' }
  const rows = { '9th': [6, 15], '10th': [24, 33], '11th': [6, 15], '12th': [24, 33] }

  const span = rows[gradeYear]
  const gCol = gradeCol[semester]?.[gradeYear]
  if (!span || !gCol) return null

  const [startRow, endRow] = span
  const nCol = nameCol[gradeYear]
  return {
    namesRange: `🎓 Transcript!${nCol}${startRow}:${nCol}${endRow}`,
    gradesRange: `🎓 Transcript!${gCol}${startRow}:${gCol}${endRow}`,
    gradesStartRow: startRow,
    gradesCol: gCol,
    gradesRowCount: endRow - startRow + 1,
  }
}

// The authoritative check-in target for the CURRENT session.
// Returns { error } (a ready Response) when there is no session or the signed-in
// email owns no student row — a parent signing in resolves to no student, which
// is correct: parents do not submit check-ins.
export async function resolveCheckinStudent() {
  const { sessionClaims } = await auth()
  const email = sessionClaims?.email
  if (!email) {
    return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const sheets = getGoogleSheetsClient(email)

  const masterRes = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${MASTER_TAB}!A:AY`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  })
  const rows = masterRes.data.values || []
  // col J (index 9) = student email — the same key getUpdateFormData resolves on.
  const idx = rows.findIndex((r) => r?.[9] === email)
  if (idx === -1) {
    return { error: Response.json({ error: 'Student not found' }, { status: 404 }) }
  }
  const row = rows[idx]

  const sheetIdMatch = String(row[6] ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/)
  if (!sheetIdMatch) {
    return { error: Response.json({ error: 'No student sheet found' }, { status: 404 }) }
  }
  const studentSheetId = sheetIdMatch[1]

  // ONE read covers both Overview cells the check-in path needs: B2 (the name
  // every existing check-in row was written with) and C4 (grade year, for the
  // grade-write grid). getUpdateFormData spends two parallel reads on the same
  // pair; this is the write path, so it spends one.
  let overviewName = ''
  let gradeYear = null
  try {
    const ov = await sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: '🔎 Overview!B2:C4',
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
    const grid = ov.data.values || []
    overviewName = grid[0]?.[0] ?? ''      // B2
    gradeYear = grid[2]?.[1] ?? null       // C4
  } catch (err) {
    // Non-fatal by design. The name falls back to the roster spelling and the
    // grade write is skipped, but the check-in itself still lands. Before this
    // guard a transient Sheets blip on the student's own sheet would 500 the
    // whole submission, which is strictly worse than a check-in without grades.
    console.error('[checkinIdentity] Overview read failed:', err?.message)
  }

  const rosterName = String(row[0] ?? '').trim()

  return {
    email,
    // 1-based sheet row, matching getUpdateFormData's `rows.indexOf(...) + 1`.
    studentRowIndex: idx + 1,
    studentSheetId,
    // ⚠ Overview B2, VERBATIM — not trimmed. The existing CheckinForm rows carry
    // whatever B2 holds, trailing space included, and downstream matching is
    // exact (submitUpdateForm's grade-history filter, bookMeeting's agenda write).
    // Trimming here would orphan those rows just as surely as switching source.
    studentName: overviewName || rosterName,
    rosterName,
    gradeYear,
    sheets,
  }
}

// Rebuild the grade write targets for a resolved student, ignoring anything the
// client sent. `grades` is the client's [{ rowOffset, grade }] — the VALUES are
// still the student's to supply, but every RANGE is computed here and every
// rowOffset is bounds-checked against the grid the student's own grade year owns.
// Returns [] when the student is on a no-grades track (summer / MS / unknown
// year), the same condition getUpdateFormData reports as `skip: true`.
export function buildGradeWriteData(gradeYear, grades) {
  if (!Array.isArray(grades) || !grades.length) return []

  const ranges = getGradeRanges(gradeYear, getCurrentSemester())
  if (!ranges) return []

  const { gradesCol, gradesStartRow, gradesRowCount } = ranges
  const data = []
  for (const { rowOffset, grade } of grades) {
    const offset = Number(rowOffset)
    if (!Number.isInteger(offset) || offset < 0 || offset >= gradesRowCount) continue
    data.push({
      range: `🎓 Transcript!${gradesCol}${gradesStartRow + offset}`,
      values: [[grade]],
    })
  }
  return data
}
