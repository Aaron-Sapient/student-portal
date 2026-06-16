import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'
import { resolveStudentFolderId, streamDriveFileFromFolder } from '@/lib/studentFiles'
import { normEmail, sessionEmail } from '@/lib/identity'

// Streams a Drive file's bytes through the portal with its real Content-Type, so
// uploaded HTML (and other text) renders instead of showing as raw source the way
// Drive's own /view does. Access is gated: the file must live directly in the
// student's OWN folder (the 🔎 Overview H2/L2 link), re-resolved here from the
// session — a student can't fetch arbitrary Drive files via the service account.
export async function GET(request) {
  const { userId, sessionClaims } = await auth()
  if (!userId) return new Response('Unauthorized', { status: 401 })

  const fileId = new URL(request.url).searchParams.get('id')
  if (!fileId) return new Response('Missing id', { status: 400 })

  const userEmail = sessionEmail(sessionClaims)
  const sheets = getGoogleSheetsClient(userEmail)

  // email -> student sheet
  const masterRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: "'👩‍🎓 All Data'!G:BD",
  })
  const studentRow = (masterRes.data.values || []).find(
    (r) => normEmail(r[3]) === normEmail(userEmail)
  )
  if (!studentRow) return new Response('Not found', { status: 404 })
  const sheetIdMatch = studentRow[0]?.match(/\/d\/([a-zA-Z0-9-_]+)/)
  if (!sheetIdMatch) return new Response('Not found', { status: 404 })

  const folderId = await resolveStudentFolderId(sheets, sheetIdMatch[1])
  if (!folderId) return new Response('Not found', { status: 404 })

  return streamDriveFileFromFolder(folderId, fileId)
}
