import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'
import { readLocalExternalFile } from '@/lib/studentFiles'

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

// Streams a single student-facing local file. The student is re-resolved from the
// session here (never trusted from the client), and the helper only serves _EXTERNAL
// files that live directly in that student's own folder — so this can't reach internal
// files or escape via path traversal. Dev-only: returns 404 where the fs isn't present.
export async function GET(request) {
  const { userId, sessionClaims } = await auth()
  if (!userId) return new Response('Unauthorized', { status: 401 })

  const requestedName = new URL(request.url).searchParams.get('name')
  if (!requestedName) return new Response('Missing file', { status: 400 })

  const userEmail =
    sessionClaims?.email ?? sessionClaims?.primary_email_address ?? null

  const sheets = getGoogleSheetsClient(userEmail)
  const masterRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: "'👩‍🎓 All Data'!G:BD",
  })
  const studentRow = (masterRes.data.values || []).find(
    (row) => row[3]?.toLowerCase() === userEmail?.toLowerCase()
  )
  if (!studentRow) return new Response('Not found', { status: 404 })

  const sheetIdMatch = studentRow[0]?.match(/\/d\/([a-zA-Z0-9-_]+)/)
  if (!sheetIdMatch) return new Response('Not found', { status: 404 })

  const nameRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetIdMatch[1],
    range: "'🔎 Overview'!B2:C3",
  })
  // B2 = name (row0,col0); C3 = grad year (row1,col1)
  const ov = nameRes.data.values || []
  const studentName = ov[0]?.[0] || ''
  const gradYear = ov[1]?.[1] || ''

  const file = await readLocalExternalFile(studentName, gradYear, requestedName)
  if (!file) return new Response('Not found', { status: 404 })

  const contentType = CONTENT_TYPES[file.ext] || 'application/octet-stream'
  return new Response(file.buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${file.filename}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
