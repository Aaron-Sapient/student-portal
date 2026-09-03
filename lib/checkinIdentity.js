import { auth } from '@clerk/nextjs/server'
import { google } from 'googleapis'
import { getStudentByEmail, getStudentProfile, studentDisplay } from '@/lib/identity'

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
// THE ROW INDEX IS GONE (Package D, 2026-09-02). This module used to hand back a
// 1-based Master row so callers could write `AY${rowIndex}` / `BA${rowIndex}`, and
// it read the Master fresh (never the cached roster) precisely because a cache
// stale across a row insert would land one student's check-in stamp on another
// student's row. Both writes are now keyed updates on `students`, so the whole
// hazard class — and the read that existed to manage it — is deleted rather than
// mitigated. Nothing derives a coordinate from a scan position any more.
// ============================================================================

// ⚠ The `sheets` handed back to callers MUST be WRITE-scoped. lib/google.js's
// shared client is spreadsheets.readonly by design (it protects the read quota),
// and the first version of this module returned that client — every check-in
// write then failed with "Request had insufficient authentication scopes"
// (Christine Oh, 2026-08-24 21:59, ~3h after cbebb24 went live). The reads above
// stay on the quota-keyed readonly client; the writes get this one.
function getWriteSheetsClient() {
  const authClient = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth: authClient })
}

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
  // `students` is the record of truth (ruling 2026-08-27). Was a Master A:AY scan
  // matched on col J. getStudentByEmail rethrows a Supabase error, so a blip 500s
  // here rather than resolving a real student to "not found" and writing nothing.
  const student = await getStudentByEmail(email)
  if (!student) {
    return { error: Response.json({ error: 'Student not found' }, { status: 404 }) }
  }
  const studentSheetId = student.student_sheet_id
  if (!studentSheetId) {
    return { error: Response.json({ error: 'No student sheet found' }, { status: 404 }) }
  }

  // Both Overview cells the check-in path needs — B2 (the name every existing
  // check-in row was written with) and C4 (grade year, for the grade-write
  // grid) — come from the student_profiles mirror (ruling 2026-08-27: no
  // student-sheet read). display_name is stored VERBATIM, trailing space and
  // all, so the name contract below is unchanged. Same graceful shape as the
  // old Sheets read: getStudentProfile never throws, a missing profile row
  // degrades to the roster spelling and the grade write is skipped, but the
  // check-in itself still lands — a name/grade blip must never 500 a submission.
  //
  // ⚠ ONLY `name` is passed, never `class` or `grade`. studentDisplay's last-resort
  // degrade is gradeLabelFromClass(), which DERIVES a grade from class-year
  // arithmetic — and this value is not for display, it picks the 🎓 Transcript row
  // block the submission's grades are WRITTEN into. A failed profile read must leave
  // gradeYear null so buildGradeWriteData returns [] and the grades are skipped;
  // letting a computed year through would write real grades into a guessed block.
  // `students` now HAS a grade column, which makes passing the whole row the obvious
  // move and the wrong one. Keep it narrow.
  const rosterName = String(student.name ?? '').trim()
  const profile = await getStudentProfile(studentSheetId)
  const { studentName, currentYear: gradeYear } = studentDisplay(
    { name: rosterName },
    profile
  )

  return {
    email,
    studentId: student.id,
    studentSheetId,
    // ⚠ Overview B2 (via student_profiles.display_name), VERBATIM — not trimmed.
    // The existing CheckinForm rows carry whatever B2 holds, trailing space
    // included, and downstream matching is exact (submitUpdateForm's
    // grade-history filter, bookMeeting's agenda write). Trimming here would
    // orphan those rows just as surely as switching source.
    studentName,
    rosterName,
    gradeYear,
    sheets: getWriteSheetsClient(),
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
