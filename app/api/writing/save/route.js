import { getSupabaseClient } from '@/lib/supabase'
import { resolveActorOrLink, canEditStudent } from '@/lib/writingAuth'
import { tabContext, appendRevision } from '@/lib/writingDocs'

// POST /api/writing/save  body: { tab_id, body_markdown, note? }
// Appends a new revision (becomes canonical). Editor identity is derived
// server-side from the Clerk session — never trusted from the client.
export async function POST(request) {
  const actor = await resolveActorOrLink()
  if (actor.error) return actor.error

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }
  const tabId = body?.tab_id
  if (!tabId || typeof body?.body_markdown !== 'string') {
    return Response.json({ error: 'Missing tab_id or body_markdown' }, { status: 400 })
  }

  const supabase = getSupabaseClient()
  const ctx = await tabContext(supabase, tabId)
  if (!ctx) return Response.json({ error: 'Not found' }, { status: 404 })
  if (!canEditStudent(actor, ctx.studentSheetId)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const editor = { email: actor.email, role: actor.role, name: actor.name }
  const res = await appendRevision(supabase, tabId, body.body_markdown, editor, 'edit', body.note)
  if (res.error) {
    return Response.json({ error: res.error }, { status: res.conflict ? 409 : 502 })
  }
  return Response.json({ ok: true, revision: res.revision })
}
