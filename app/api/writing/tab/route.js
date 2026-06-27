import { getSupabaseClient } from '@/lib/supabase'
import { resolveActorOrLink, canEditStudent } from '@/lib/writingAuth'
import {
  docContext,
  tabContext,
  createManualTab,
  renameTab,
  reorderTabs,
  deleteTab,
  tabIsDeletable,
} from '@/lib/writingDocs'

// POST /api/writing/tab — manual tab management.
//   { action:'create',  document_id, title }
//   { action:'rename',  tab_id, title }
//   { action:'reorder', document_id, orderedIds:[...] }
//   { action:'delete',  tab_id }
export async function POST(request) {
  const actor = await resolveActorOrLink()
  if (actor.error) return actor.error

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }
  const supabase = getSupabaseClient()
  const action = body?.action
  const forbidden = Response.json({ error: 'Forbidden' }, { status: 403 })
  const notFound = Response.json({ error: 'Not found' }, { status: 404 })

  if (action === 'create') {
    const doc = await docContext(supabase, body?.document_id)
    if (!doc) return notFound
    if (!canEditStudent(actor, doc.student_sheet_id)) return forbidden
    const student =
      actor.role === 'student'
        ? { email: actor.email, name: actor.name }
        : { email: '', name: 'Student' }
    const tab = await createManualTab(supabase, doc.id, body?.title, student)
    // tell the client whether this fresh tab may be deleted, so the widget's
    // per-tab Delete shows consistently with what the server will allow.
    const deletable = tab ? tabIsDeletable({ origin: 'manual', syncState: 'manual_active' }) : false
    return Response.json({ ok: true, tab: tab ? { ...tab, deletable } : tab })
  }

  if (action === 'rename') {
    const title = String(body?.title ?? '').trim()
    if (!title) return Response.json({ error: 'Missing title' }, { status: 400 })
    const ctx = await tabContext(supabase, body?.tab_id)
    if (!ctx) return notFound
    if (!canEditStudent(actor, ctx.studentSheetId)) return forbidden
    await renameTab(supabase, body.tab_id, title)
    return Response.json({ ok: true })
  }

  if (action === 'reorder') {
    const doc = await docContext(supabase, body?.document_id)
    if (!doc) return notFound
    if (!canEditStudent(actor, doc.student_sheet_id)) return forbidden
    const ids = Array.isArray(body?.orderedIds) ? body.orderedIds : []
    await reorderTabs(supabase, doc.id, ids)
    return Response.json({ ok: true })
  }

  if (action === 'delete') {
    const ctx = await tabContext(supabase, body?.tab_id)
    if (!ctx) return notFound
    if (!canEditStudent(actor, ctx.studentSheetId)) return forbidden
    // re-check deletability server-side — never trust the client's gating.
    if (!tabIsDeletable({ origin: ctx.origin, syncState: ctx.syncState })) {
      return Response.json({ error: 'This tab can’t be deleted' }, { status: 409 })
    }
    await deleteTab(supabase, body.tab_id)
    return Response.json({ ok: true })
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 })
}
