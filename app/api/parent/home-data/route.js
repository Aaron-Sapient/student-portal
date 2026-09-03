import { DateTime } from 'luxon'
import { getStudentProfile, requireParent, studentDisplay } from '@/lib/identity'
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
  const [projectRows, profile, rawScores, gradeGate] = await Promise.all([
    // 🏆 Comps & Projects E:N rows per the `comps` flag (Sheets today).
    getProjectRows(sheets, child.sheetId),
    // Was 🔎 Overview!B2:C4 on the child's sheet (B2 = name, C4 = "Current Year:",
    // which gates the Colleges tab). Now the student_profiles mirror. A child with
    // no profile row degrades to the roster name + class-derived grade instead of
    // 500-ing this whole payload — the Ryan Koo failure, one storage layer over.
    getStudentProfile(child.sheetId),
    getStudentScores(sheets, child.sheetId, gradeFromClass(child.grade)),
    // Data-sufficiency gate per the `transcript` flag (Sheets today); on a read
    // error fall through to hasRecentGrades([]) — exact prior `.catch(()=>null)` behavior.
    studentGradeGate(sheets, child.sheetId, child.grade, { year: nowLA.year, month: nowLA.month })
      .catch(() => hasRecentGrades([], child.grade, { year: nowLA.year, month: nowLA.month })),
  ])

  // Same gate as /api/home-data; gradeGate comes from the flag-gated reader above.
  const scores = gradeGate.enough ? rawScores : { insufficientData: true }

  // Colleges tab = 12th-graders only — gate on grade (student_profiles.current_year,
  // ex-🔎 Overview!C4), not 🏫 College List tab presence (every student has that tab
  // from day 1). `child.grade` is the raw Class cell, which studentDisplay treats as
  // both grade and class for the degrade chain.
  const { studentName, currentYear } = studentDisplay(
    { name: child.name, grade: null, class: child.grade },
    profile
  )
  const hasCollegeList = currentYear === '12th'

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
