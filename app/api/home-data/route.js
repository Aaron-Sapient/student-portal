import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'

export async function GET() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const userEmail = sessionClaims?.email ?? sessionClaims?.primary_email_address ?? null
  console.log('Full sessionClaims:', JSON.stringify(sessionClaims))
  console.log('1. User email from Clerk:', userEmail)

  const sheets = getGoogleSheetsClient()

  const masterRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: "'👩‍🎓 All Data'!G:J",
  })

  const masterRows = masterRes.data.values || []
  console.log('2. Master sheet rows found:', masterRows.length)
  console.log('3. First few rows:', JSON.stringify(masterRows.slice(0, 3)))

  const studentRow = masterRows.find(row => row[3]?.toLowerCase() === userEmail?.toLowerCase())
  console.log('4. Student row found:', JSON.stringify(studentRow))

  if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 })
console.log('Email matching attempt:')
  
masterRows.forEach((row, i) => {
  if (row[3]) console.log(`Row ${i}: "${row[3]}" === "${userEmail}" → ${row[3]?.toLowerCase() === userEmail?.toLowerCase()}`)
})
  const portalUrl = studentRow[0]
  console.log('5. Portal URL:', portalUrl)

  const sheetIdMatch = portalUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/)
  console.log('6. Extracted sheet ID:', sheetIdMatch?.[1])

  if (!sheetIdMatch) return Response.json({ error: 'Invalid portal URL' }, { status: 400 })

  const studentSheetId = sheetIdMatch[1]

const projectsRes = await sheets.spreadsheets.values.get({
  spreadsheetId: studentSheetId,
  range: "'🏆 Comps & Projects'!E:M",
  valueRenderOption: 'UNFORMATTED_VALUE',
})

  const projectRows = projectsRes.data.values || []
  console.log('7. Project rows found:', projectRows.length)
  console.log('8. All project rows:', JSON.stringify(projectRows))

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const activeProjects = projectRows
    .slice(1)
.filter(row => {
  const rawDate = row[2] // column G
  if (!rawDate) return false
  
  // Handle Google Sheets serial number (days since Dec 30, 1899)
  let endDate
  if (typeof rawDate === 'number') {
    endDate = new Date((rawDate - 25569) * 86400 * 1000)
  } else {
    endDate = new Date(rawDate)
  }
  
  console.log('9. Row:', row[0], '| raw:', rawDate, '| parsed:', endDate, '| passes:', endDate >= today)
  return !isNaN(endDate) && endDate >= today
})
    .map(row => ({
      name: row[0],
      endDate: row[2],
      progress: row[4],
      link: row[8],
    }))

  console.log('10. Active projects:', JSON.stringify(activeProjects))

  return Response.json({ activeProjects })
}