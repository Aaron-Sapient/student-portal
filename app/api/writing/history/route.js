import { getSupabaseClient } from '@/lib/supabase'
import { resolveActorOrLink, canEditStudent } from '@/lib/writingAuth'
import { tabContext, getTabHistory, getTabBody, appendRevision } from '@/lib/writingDocs'

// GET /api/writing/history?tab_id=<id>[&revision=N]
//   no revision → the WHO-edited timeline (newest first)
//   &revision=N → that revision's body (for preview / pre-restore)
export async function GET(request) {
  const actor = await resolveActorOrLink()
  if (actor.error) return actor.error

  const url = new URL(request.url)
  const tabId = url.searchParams.get('tab_id')
  const revisionParam = url.searchParams.get('revision')
  if (!tabId) return Response.json({ error: 'Missing tab_id' }, { status: 400 })

  const supabase = getSupabaseClient()
  const ctx = await tabContext(supabase, tabId)
  if (!ctx) return Response.json({ error: 'Not found' }, { status: 404 })
  if (!canEditStudent(actor, ctx.studentSheetId)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (revisionParam != null) {
    const rev = await getTabBody(supabase, tabId, revisionParam)
    if (!rev) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json({ revision: rev.revision, body_markdown: rev.body_md })
  }
  return Response.json({ history: await getTabHistory(supabase, tabId) })
}

// POST /api/writing/history  body: { tab_id, revision }
// Restore a prior revision by APPENDING it as a new revision (never mutates
// history), stamped with the restoring editor.
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
  if (!tabId || body?.revision == null) {
    return Response.json({ error: 'Missing tab_id or revision' }, { status: 400 })
  }

  const supabase = getSupabaseClient()
  const ctx = await tabContext(supabase, tabId)
  if (!ctx) return Response.json({ error: 'Not found' }, { status: 404 })
  if (!canEditStudent(actor, ctx.studentSheetId)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const old = await getTabBody(supabase, tabId, body.revision)
  if (!old) return Response.json({ error: 'Revision not found' }, { status: 404 })

  const editor = { email: actor.email, role: actor.role, name: actor.name }
  const res = await appendRevision(
    supabase,
    tabId,
    old.body_md,
    editor,
    'restore',
    `Restored from revision ${body.revision}`
  )
  if (res.error) {
    return Response.json({ error: res.error }, { status: res.conflict ? 409 : 502 })
  }
  return Response.json({ ok: true, revision: res.revision })
}
