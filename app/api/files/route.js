import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'
import { listStudentFiles } from '@/lib/studentFiles'
import { normEmail, sessionEmail } from '@/lib/identity'

export async function GET() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const userEmail = sessionEmail(sessionClaims)
  const sheets = getGoogleSheetsClient(userEmail)

  // email -> master row -> student sheet id (same resolution as /api/home-data)
  const masterRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: "'👩‍🎓 All Data'!G:BD",
  })
  const masterRows = masterRes.data.values || []
  const studentRow = masterRows.find(
    (row) => normEmail(row[3]) === normEmail(userEmail)
  )
  if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 })

  const sheetIdMatch = studentRow[0]?.match(/\/d\/([a-zA-Z0-9-_]+)/)
  if (!sheetIdMatch) return Response.json({ error: 'Invalid portal URL' }, { status: 400 })

  const payload = await listStudentFiles(sheets, sheetIdMatch[1])
  return Response.json(payload)
}
