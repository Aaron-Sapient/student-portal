import { DateTime } from 'luxon'
import { requireParent } from '@/lib/identity'
import { getStudentScores, gradeFromClass } from '@/lib/scores'
import { hasRecentGrades } from '@/lib/gradeData'
import { studentGradeGate } from '@/lib/transcript'
import { activeProjectsFromRows, getProjectRows } from '@/lib/projects'

// Parent-scoped Home payload: same shapes as /api/home-data so the shared home
// components render unmodified, but stripped by construction — no check-in
// state, no booking decisions or ART tokens, no session counts, no coach note.
export async function GET(request) {
  const { child, sheets, error } = await requireParent(request)
  if (error) return error

  const nowLA = DateTime.now().setZone('America/Los_Angeles')
  const [projectRows, nameRes, rawScores, gradeGate] = await Promise.all([
    // 🏆 Comps & Projects E:N rows per the `comps` flag (Sheets today).
    getProjectRows(sheets, child.sheetId),
    sheets.spreadsheets.values.get({
      spreadsheetId: child.sheetId,
      // B2 = student name; C4 = "Current Year:" grade (gates the Colleges tab).
      range: "'🔎 Overview'!B2:C4",
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    getStudentScores(sheets, child.sheetId, gradeFromClass(child.grade)),
    // Data-sufficiency gate per the `transcript` flag (Sheets today); on a read
    // error fall through to hasRecentGrades([]) — exact prior `.catch(()=>null)` behavior.
    studentGradeGate(sheets, child.sheetId, child.grade, { year: nowLA.year, month: nowLA.month })
      .catch(() => hasRecentGrades([], child.grade, { year: nowLA.year, month: nowLA.month })),
  ])

  // Same gate as /api/home-data; gradeGate comes from the flag-gated reader above.
  const scores = gradeGate.enough ? rawScores : { insufficientData: true }

  // Colleges tab = 12th-graders only — gate on grade (🔎 Overview!C4 === "12th"),
  // not 🏫 College List tab presence (every student has that tab from day 1).
  const currentYear = String(nameRes.data.values?.[2]?.[1] || '').trim()
  const hasCollegeList = currentYear === '12th'

  const studentName = nameRes.data.values?.[0]?.[0] || child.name

  const activeProjects = activeProjectsFromRows(projectRows)

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
