import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'
import { fetchCollegeData } from '@/lib/collegeList'
import { normEmail, sessionEmail } from '@/lib/identity'

export async function GET() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const userEmail = sessionEmail(sessionClaims)
  const sheets = getGoogleSheetsClient(userEmail)

  // Master sheet → this student's row → their individual sheet id.
  const masterRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: "'👩‍🎓 All Data'!G:BD",
  })
  const studentRow = (masterRes.data.values || []).find(
    (row) => normEmail(row[3]) === normEmail(userEmail)
  )
  if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 })

  const sheetIdMatch = studentRow[0]?.match(/\/d\/([a-zA-Z0-9-_]+)/)
  if (!sheetIdMatch) return Response.json({ error: 'Invalid portal URL' }, { status: 400 })

  const payload = await fetchCollegeData(sheets, sheetIdMatch[1])
  if (!payload) return Response.json({ error: 'No college list yet' }, { status: 404 })
  return Response.json(payload)
}
