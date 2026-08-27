import { requireSessionEmail, getDocument, canAccess, currentBody, saveEdit } from '@/lib/studentFiles'
import { sanitizeDocumentHtml } from '@/lib/htmlSanitize'

// The in-portal editor's API (app/edit/EditorView.js). `file` is now the document
// uuid. There is no revision history any more (§5 of the consultant brief: the
// working copy is ONE row in document_edits; the pushed original is never written
// here). The response keeps the shape EditorView renders — `revision` 0 = the
// original, 1 = the student's working copy — so "restore original" still works
// through `?revision=0`.

async function resolve(request) {
  const session = await requireSessionEmail()
  if (session.error) return session
  const url = new URL(request.url)
  const id = url.searchParams.get('file')
  if (!id) return { error: Response.json({ error: 'Missing file' }, { status: 400 }) }
  const document = await getDocument(id)
  if (!document) return { error: Response.json({ error: 'Not found' }, { status: 404 }) }
  const access = await canAccess(session.email, document)
  if (!access.read) return { error: Response.json({ error: 'Not found' }, { status: 404 }) }
  return { email: session.email, document, access, url }
}

function historyFor(document, edited) {
  const h = [{ revision: 0, source: 'baseline', note: 'Original', created_at: document.pushed_at }]
  if (edited.edited) h.unshift({ revision: 1, source: 'student', note: null, created_at: edited.edited_at })
  return h
}

// GET /api/files/editable?file=<uuid>[&revision=0]
export async function GET(request) {
  const ctx = await resolve(request)
  if (ctx.error) return ctx.error
  const { document, url } = ctx
  try {
    const edited = await currentBody(document)
    const wantOriginal = url.searchParams.get('revision') === '0'
    const html = wantOriginal ? document.body : edited.body
    return Response.json({
      filename: document.id,
      title: document.title,
      html: html ?? '',
      revision: wantOriginal || !edited.edited ? 0 : 1,
      source: wantOriginal || !edited.edited ? 'baseline' : 'student',
      note: wantOriginal || !edited.edited ? 'Original' : null,
      editable: Boolean(ctx.access.write),
      history: historyFor(document, edited),
    })
  } catch (err) {
    console.error('files/editable GET error:', err)
    return Response.json({ error: 'Load failed' }, { status: 502 })
  }
}

// POST /api/files/editable  body: { filename: <uuid>, html }
export async function POST(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }
  if (!body?.filename || typeof body?.html !== 'string') {
    return Response.json({ error: 'Missing filename or html' }, { status: 400 })
  }
  const ctx = await resolve(new Request(`${request.url}?file=${encodeURIComponent(body.filename)}`))
  if (ctx.error) return ctx.error
  if (!ctx.access.write) return Response.json({ error: 'Read only' }, { status: 403 })
  try {
    await saveEdit(ctx.document, sanitizeDocumentHtml(body.html), ctx.email)
    return Response.json({ ok: true, revision: 1 })
  } catch (err) {
    console.error('files/editable POST error:', err)
    return Response.json({ error: 'Save failed' }, { status: 502 })
  }
}
