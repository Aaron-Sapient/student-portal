import { DateTime } from 'luxon'
import { requireParent } from '@/lib/identity'
import { getStudentScores, gradeFromClass } from '@/lib/scores'
import { hasRecentGrades, TRANSCRIPT_GRADE_RANGE } from '@/lib/gradeData'
import { activeProjectsFromRows } from '@/lib/projects'

// Parent-scoped Home payload: same shapes as /api/home-data so the shared home
// components render unmodified, but stripped by construction — no check-in
// state, no booking decisions or ART tokens, no session counts, no coach note.
export async function GET(request) {
  const { child, sheets, error } = await requireParent(request)
  if (error) return error

  const [projectsRes, nameRes, rawScores, transcriptRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: child.sheetId,
      // E:N — Owner lives in col N (relative index 9); same block as /api/home-data.
      range: "'🏆 Comps & Projects'!E:N",
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: child.sheetId,
      // B2 = student name; C4 = "Current Year:" grade (gates the Colleges tab).
      range: "'🔎 Overview'!B2:C4",
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    getStudentScores(sheets, child.sheetId, gradeFromClass(child.grade)),
    sheets.spreadsheets.values
      .get({
        spreadsheetId: child.sheetId,
        range: TRANSCRIPT_GRADE_RANGE,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      .catch(() => null),
  ])

  // Same data-sufficiency gate as /api/home-data: no recent grades → grayed-out
  // score dashboard (parents see the identical gauge component).
  const nowLA = DateTime.now().setZone('America/Los_Angeles')
  const gradeGate = hasRecentGrades(
    transcriptRes?.data?.values || [],
    child.grade,
    { year: nowLA.year, month: nowLA.month }
  )
  const scores = gradeGate.enough ? rawScores : { insufficientData: true }

  // Colleges tab = 12th-graders only — gate on grade (🔎 Overview!C4 === "12th"),
  // not 🏫 College List tab presence (every student has that tab from day 1).
  const currentYear = String(nameRes.data.values?.[2]?.[1] || '').trim()
  const hasCollegeList = currentYear === '12th'

  const studentName = nameRes.data.values?.[0]?.[0] || child.name

  const activeProjects = activeProjectsFromRows(projectsRes.data.values)

  let progress = null
  {
    const vals = activeProjects
      .map((p) => p.progress)
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
    if (vals.length) {
      progress = {
        value: vals.reduce((a, b) => a + b, 0) / vals.length,
        count: vals.length,
      }
    }
  }

  return Response.json({
    studentName,
    activeProjects,
    progress,
    hasCollegeList,
    scores,
  })
}
