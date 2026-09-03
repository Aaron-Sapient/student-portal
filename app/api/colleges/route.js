import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'
import { fetchCollegeData } from '@/lib/collegeList'
import { getStudentByEmail, sessionEmail } from '@/lib/identity'

export async function GET() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const userEmail = sessionEmail(sessionClaims)

  // `students` → this student's sheet id. The Master G:BD scan is gone.
  const student = await getStudentByEmail(userEmail)
  if (!student) return Response.json({ error: 'Student not found' }, { status: 404 })
  if (!student.student_sheet_id) {
    return Response.json({ error: 'No student sheet found' }, { status: 404 })
  }

  // The college list itself still lives on the student sheet — lib/collegeList.js
  // is out of B/D/F scope, so this client stays.
  const sheets = getGoogleSheetsClient(userEmail)
  const payload = await fetchCollegeData(sheets, student.student_sheet_id)
  if (!payload) return Response.json({ error: 'No college list yet' }, { status: 404 })
  return Response.json(payload)
}
