import { getSupabaseClient, STUDENT_COLLEGE_LISTS, MD_DOCUMENTS } from '@/lib/supabase'
import { resolveViewTarget } from '@/lib/writingAuth'
import {
  ensureDocuments,
  syncTabs,
  listTabsOrdered,
  entriesFromCollegeList,
} from '@/lib/writingDocs'

// GET /api/writing  → the writing MAP (no bodies): the 3 docs with their tabs +
// ids, used to build the fixed per-doc links (/write/<docId>) and per-tab deep
// links (?tab=<tabId>) on the Colleges cards. Ensures docs + syncs tabs so the
// ids exist. Student → own; admin → ?student; parent → ?student (own child).
const DOC_LABEL = {
  COMMON_APP: 'Common App',
  UC_PIQ: 'UC PIQs',
  SUPPLEMENTAL: 'Supplements',
}

export async function GET(request) {
  const ctx = await resolveViewTarget(request)
  if (ctx.error) return ctx.error

  const { studentSheetId, studentEmail, studentName } = ctx
  const student = { email: studentEmail, name: studentName }
  const supabase = getSupabaseClient()

  const { data: mirror } = await supabase
    .from(STUDENT_COLLEGE_LISTS)
    .select('payload,updated_at')
    .eq('student_sheet_id', studentSheetId)
    .maybeSingle()

  // Editors (student/admin) materialize + sync the structure; parents are
  // strictly read-only and see whatever the student has already created.
  let docs = {}
  if (ctx.canEdit) {
    docs = await ensureDocuments(supabase, studentSheetId, student)
    const { piq, supplemental } = entriesFromCollegeList(mirror?.payload || {})
    await syncTabs(supabase, docs.UC_PIQ.id, piq, student)
    await syncTabs(supabase, docs.SUPPLEMENTAL.id, supplemental, student)
  } else {
    const { data } = await supabase
      .from(MD_DOCUMENTS)
      .select('id,doc_type')
      .eq('student_sheet_id', studentSheetId)
    for (const d of data || []) docs[d.doc_type] = d
  }

  const out = []
  for (const type of ['COMMON_APP', 'UC_PIQ', 'SUPPLEMENTAL']) {
    const doc = docs[type]
    if (!doc) continue
    const tabs = await listTabsOrdered(supabase, doc.id)
    out.push({
      docType: type,
      label: DOC_LABEL[type],
      id: doc.id,
      tabs: tabs.map((t) => ({
        id: t.id,
        title: t.title,
        sync_key: t.sync_key,
        dim: t.sync_state === 'orphaned',
      })),
    })
  }

  return Response.json({
    studentSheetId,
    student: { name: studentName },
    canEdit: ctx.canEdit,
    hasCollegeList: !!mirror,
    collegeListUpdatedAt: mirror?.updated_at ?? null,
    docs: out,
  })
}
