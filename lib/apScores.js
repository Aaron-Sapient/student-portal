import { DateTime } from 'luxon'

const ZONE = 'America/Los_Angeles'

// Standard College Board AP exam catalog, for the "add another exam"
// self-study picker (Ryan/Aaron's own transcript entries use inconsistent
// freehand names — "APUSH", "BC Calc" — so new self-reports use this
// consistent list instead of freehand text).
export const AP_SUBJECTS = [
  'AP 2-D Art and Design',
  'AP 3-D Art and Design',
  'AP Art History',
  'AP Biology',
  'AP Calculus AB',
  'AP Calculus BC',
  'AP Chemistry',
  'AP Chinese Language and Culture',
  'AP Comparative Government and Politics',
  'AP Computer Science A',
  'AP Computer Science Principles',
  'AP Drawing',
  'AP English Language and Composition',
  'AP English Literature and Composition',
  'AP Environmental Science',
  'AP European History',
  'AP French Language and Culture',
  'AP German Language and Culture',
  'AP Human Geography',
  'AP Italian Language and Culture',
  'AP Japanese Language and Culture',
  'AP Latin',
  'AP Macroeconomics',
  'AP Microeconomics',
  'AP Music Theory',
  'AP Physics 1',
  'AP Physics 2',
  'AP Physics C: Electricity and Magnetism',
  'AP Physics C: Mechanics',
  'AP Precalculus',
  'AP Psychology',
  'AP Research',
  'AP Seminar',
  'AP Spanish Language and Culture',
  'AP Spanish Literature and Culture',
  'AP Statistics',
  'AP United States Government and Politics',
  'AP United States History',
  'AP World History: Modern',
]

// Mirrors the row/column layout app/api/getUpdateFormData/route.js's
// getGradeRanges() uses for the SAME 🎓 Transcript tab (verified independently
// against 3 live student sheets, 2026-07-07 — identical layout on every one).
const TRANSCRIPT_ROWS = { '9th': [6, 15], '10th': [24, 33], '11th': [6, 15], '12th': [24, 33] }
const TRANSCRIPT_NAME_COL = { '9th': 'E', '10th': 'E', '11th': 'P', '12th': 'P' }

// The transcript's own per-course "AP" checkbox isn't reliably filled in by
// staff (verified against real data — "AP Precalc" had it unchecked), so
// detection is by course-name pattern instead.
const AP_NAME_RE = /^AP(\s|[A-Z])/i

// Which grade the student was in during the most recently COMPLETED school
// year. AP exams are taken in May and scores land in July, so a student is
// always reporting on the year that JUST ended, never the one in progress.
// gradYear = 4-digit graduation year (e.g. 2028, from identity.js classYearFromClass).
export function gradeYearJustCompleted(gradYear, nowLA = DateTime.now().setZone(ZONE)) {
  if (!Number.isFinite(gradYear)) return null
  const yearsBeforeGrad = gradYear - nowLA.year
  const map = { 0: '12th', 1: '11th', 2: '10th', 3: '9th' }
  return map[yearsBeforeGrad] ?? null
}

// Best-effort scan of the student's own 🎓 Transcript for AP-flagged course
// names in one grade-year block, to auto-populate the check-in form.
export async function getDetectedApCourses(sheets, studentSheetId, gradeYear) {
  if (!gradeYear || !TRANSCRIPT_ROWS[gradeYear]) return []
  const [startRow, endRow] = TRANSCRIPT_ROWS[gradeYear]
  const col = TRANSCRIPT_NAME_COL[gradeYear]
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: `🎓 Transcript!${col}${startRow}:${col}${endRow}`,
    })
    const names = (res.data.values || []).map((r) => String(r?.[0] ?? '').trim())
    return names.filter((n) => AP_NAME_RE.test(n)).map((name) => ({ name }))
  } catch (err) {
    console.error('getDetectedApCourses: transcript read failed', err)
    return []
  }
}

// ── Sheet write-back: 📃 Student Info!B58:AB74 "AP/IB/SAT Subjects" grid ────
// 8 row-slots × 2 side-by-side blocks (left/right) = 16 entries max, each a
// merged Date/Subject/Score cell trio. Verified identical across 3 live
// student sheets, 2026-07-07 (same 85-merge layout on every one).
const AP_SECTION_ROWS = [60, 62, 64, 66, 68, 70, 72, 74]
const AP_BLOCKS = [
  { date: 'D', subject: 'G', score: 'N' }, // left
  { date: 'R', subject: 'U', score: 'AB' }, // right
]

async function findEmptyApSlots(sheets, studentSheetId) {
  const ranges = []
  for (const row of AP_SECTION_ROWS) {
    for (const block of AP_BLOCKS) ranges.push(`📃 Student Info!${block.subject}${row}`)
  }
  const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId: studentSheetId, ranges })
  const valueRanges = res.data.valueRanges || []
  const slots = []
  let i = 0
  for (const row of AP_SECTION_ROWS) {
    for (const block of AP_BLOCKS) {
      const cell = valueRanges[i]?.values?.[0]?.[0]
      if (!String(cell ?? '').trim()) slots.push({ row, block })
      i++
    }
  }
  return slots
}

// Mirrors scored entries into the student's own sheet so Ryan/Aaron see them
// where they already work. Only ever APPENDS to an empty slot — never
// overwrites an existing subject row, since staff sometimes hand-annotate
// scores there (real example: "2 - will contest") that automation must not
// clobber. no_exam_taken entries are skipped entirely (this grid is for real
// exam results). Best-effort: Supabase already holds the authoritative record,
// so a sheet-write failure is logged, not thrown.
export async function writeApScoresToStudentInfo(sheets, studentSheetId, scoredEntries, todayLA) {
  if (!scoredEntries.length) return
  let slots
  try {
    slots = await findEmptyApSlots(sheets, studentSheetId)
  } catch (err) {
    console.error(`writeApScoresToStudentInfo: couldn't read slots for ${studentSheetId}`, err)
    return
  }
  const dateStr = todayLA.toFormat('MM/dd/yyyy')
  const data = []
  scoredEntries.slice(0, slots.length).forEach((entry, i) => {
    const { row, block } = slots[i]
    data.push(
      { range: `📃 Student Info!${block.date}${row}`, values: [[dateStr]] },
      { range: `📃 Student Info!${block.subject}${row}`, values: [[entry.examName]] },
      { range: `📃 Student Info!${block.score}${row}`, values: [[entry.score]] }
    )
  })
  if (scoredEntries.length > slots.length) {
    const dropped = scoredEntries.slice(slots.length).map((e) => e.examName).join(', ')
    console.error(
      `writeApScoresToStudentInfo: ${studentSheetId} has only ${slots.length} empty AP slots — ` +
      `dropped from the sheet write (still saved to Supabase): ${dropped}`
    )
  }
  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: studentSheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    })
  } catch (err) {
    console.error(`writeApScoresToStudentInfo: sheet write failed for ${studentSheetId}`, err)
  }
}
