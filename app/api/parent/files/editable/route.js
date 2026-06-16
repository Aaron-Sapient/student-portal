import { requireParent } from '@/lib/identity'
import { getCanonicalEditableHtml } from '@/lib/editableDocs'

// Parent-scoped read-only render of an editable document: returns the child's
// CANONICAL version (their latest edit, or the counselor's original if none) as
// HTML. Same own-child gate as the other parent file routes — the folder/sheet
// is resolved from the parent's validated child, never trusted from the client.
// Parents view; only the student edits.
export async function GET(request) {
  const { child, sheets, error } = await requireParent(request)
  if (error) return error

  const filename = new URL(request.url).searchParams.get('file')
  if (!filename) return new Response('Missing file', { status: 400 })

  const html = await getCanonicalEditableHtml(sheets, child.sheetId, filename)
  if (html == null) return new Response('Not found', { status: 404 })

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
    },
  })
}
