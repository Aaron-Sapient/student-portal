import { getSupabaseClient, STUDENT_COLLEGE_LISTS } from '@/lib/supabase'
import { resolveActorOrLink, canViewStudent, canEditStudent } from '@/lib/writingAuth'
import { studentBySheetId } from '@/lib/identity'
import {
  docContext,
  syncTabs,
  listTabsOrdered,
  getTabBody,
  entriesFromCollegeList,
  tabIsDeletable,
} from '@/lib/writingDocs'

// GET /api/writing/doc?doc=<docId>  → one document's tabs + current bodies.
// Powers the full-screen /write/<docId> editor. Access resolves from the doc's
// owning student: students (own) + admins edit; a linked parent views read-only.
const DOC_LABEL = {
  COMMON_APP: 'Common App',
  UC_PIQ: 'UC PIQs',
  SUPPLEMENTAL: 'Supplements',
}

export async function GET(request) {
  const actor = await resolveActorOrLink()
  if (actor.error) return actor.error

  const docId = new URL(request.url).searchParams.get('doc')
  if (!docId) return Response.json({ error: 'Missing doc' }, { status: 400 })

  const supabase = getSupabaseClient()
  const doc = await docContext(supabase, docId)
  if (!doc) return Response.json({ error: 'Not found' }, { status: 404 })
  if (!canViewStudent(actor, doc.student_sheet_id)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }
  const canEdit = canEditStudent(actor, doc.student_sheet_id)

  const info = await studentBySheetId(actor.sheets, doc.student_sheet_id)
  const student = { email: info?.email || '', name: info?.name || 'Student' }

  // Editors keep this doc's tabs in sync with the college list; parents read as-is.
  if (canEdit) {
    const { data: mirror } = await supabase
      .from(STUDENT_COLLEGE_LISTS)
      .select('payload')
      .eq('student_sheet_id', doc.student_sheet_id)
      .maybeSingle()
    const { piq, supplemental } = entriesFromCollegeList(mirror?.payload || {})
    // COMMON_APP has no list to sync against — its default tab is seeded once at
    // doc creation (ensureDocuments), so there's nothing to materialize on read.
    if (doc.doc_type === 'UC_PIQ') {
      await syncTabs(supabase, docId, piq, student)
    } else if (doc.doc_type === 'SUPPLEMENTAL') {
      await syncTabs(supabase, docId, supplemental, student)
    }
  }

  const tabs = await listTabsOrdered(supabase, docId)
  const bodies = {}
  for (const t of tabs) {
    const b = await getTabBody(supabase, t.id)
    bodies[t.id] = b?.body_md ?? ''
  }

  return Response.json({
    doc: { id: docId, docType: doc.doc_type, label: DOC_LABEL[doc.doc_type] || 'Document' },
    student: { name: student.name },
    // The acting viewer — used by the live-collaboration layer to label this
    // user's cursor/presence to peers. role is 'admin' | 'student' | 'parent' |
    // 'link' (anonymous via the share link).
    actor: { name: actor.name || (canEdit ? 'You' : 'Viewer'), role: actor.role },
    canEdit,
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      dim: t.sync_state === 'orphaned',
      origin: t.origin,
      // editors may delete manual + orphaned tabs; active synced tabs are gated
      // (they mirror the college list and would re-sync). Default tab included.
      deletable: canEdit && tabIsDeletable({ origin: t.origin, syncState: t.sync_state }),
    })),
    bodies,
  })
}
