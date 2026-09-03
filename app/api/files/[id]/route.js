import { requireSessionEmail, getDocument, canAccess, renderDocument } from '@/lib/studentFiles'

// GET /api/files/<uuid> — render one document: html/markdown inline from the row
// (the student's working copy for editable rows, when one exists), pdf via a
// short-lived signed Storage URL. The access decision is canAccess(), nothing else.
export async function GET(_request, { params }) {
  const session = await requireSessionEmail()
  if (session.error) return session.error
  const { id } = await params
  try {
    const document = await getDocument(id)
    if (!document) return new Response('Not found', { status: 404 })
    const access = await canAccess(session.email, document)
    if (!access.read) return new Response('Not found', { status: 404 })
    return renderDocument(document)
  } catch (err) {
    console.error('files/[id] GET error:', err)
    return new Response('Could not load file', { status: 502 })
  }
}
