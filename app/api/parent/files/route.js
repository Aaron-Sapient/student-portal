import { requireParent } from '@/lib/identity'
import { listDocumentsFor, studentIdFromSheetId } from '@/lib/studentFiles'

// GET /api/parent/files?student=<sheetId> — the selected child's documents.
// requireParent validates the child against the parent's own children; the list
// itself is intersected with what canAccess would allow (guardians link), so the
// selector carries no authority on its own. Parents view; only the student edits —
// editable rows render read-only through /api/files/<id>.
export async function GET(request) {
  const { email, child, error } = await requireParent(request)
  if (error) return error
  try {
    const student = await studentIdFromSheetId(child.sheetId)
    const files = student ? await listDocumentsFor(email, { studentId: student.id }) : []
    return Response.json({
      studentName: student?.name || child.name || '',
      files,
      counts: { portal: files.length },
    })
  } catch (err) {
    console.error('parent/files GET error:', err)
    return Response.json({ error: 'Load failed' }, { status: 502 })
  }
}
