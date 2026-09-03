import { requireSessionEmail, listDocumentsFor } from '@/lib/studentFiles'

// GET /api/files — every document the signed-in email may read: a student's own
// rows, a parent's attached students' rows. One gate (canAccess semantics inside
// listDocumentsFor); no Google anywhere on this path.
export async function GET() {
  const session = await requireSessionEmail()
  if (session.error) return session.error
  try {
    const files = await listDocumentsFor(session.email)
    const studentName = files.find((f) => f.studentName)?.studentName || ''
    return Response.json({ studentName, files, counts: { portal: files.length } })
  } catch (err) {
    console.error('files GET error:', err)
    return Response.json({ error: 'Load failed' }, { status: 502 })
  }
}
