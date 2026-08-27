import { requireAdmin } from '@/lib/developerAuth'
import { listDocumentsFor } from '@/lib/studentFiles'

// GET /api/students/<uuid>/files — staff view of one student's documents
// (the brief's `/students/<id>/files`). Staff-only; students and parents use
// /api/files and /api/parent/files.
export async function GET(_request, { params }) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) {
    return Response.json({ error: 'Bad student id' }, { status: 400 })
  }
  try {
    const files = await listDocumentsFor(gate.email, { studentId: id })
    return Response.json({ files, counts: { portal: files.length } })
  } catch (err) {
    console.error('students/[id]/files GET error:', err)
    return Response.json({ error: 'Load failed' }, { status: 502 })
  }
}
