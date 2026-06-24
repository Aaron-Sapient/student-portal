import { MD_DOCUMENTS, MD_TABS, MD_TAB_REVISIONS } from './supabase.js'
import { normalizeKey } from './collegeKey.js'

export { normalizeKey }

// ============================================================================
// lib/writingDocs.js — storage for the portal markdown word processor: the
// 3-doc model, stable-id tabs, the idempotent college→tab sync, and append-only
// revisions stamped with WHO edited. Backend-only (imports just the Supabase
// table names) so the sync algorithm is node-testable. Clerk auth lives in
// lib/writingAuth.js. Schema: supabase/writing_schema.sql.
// ============================================================================

export const DOC_TYPES = ['COMMON_APP', 'UC_PIQ', 'SUPPLEMENTAL']

const DOC_LABEL = {
  COMMON_APP: 'Common App',
  UC_PIQ: 'UC PIQs',
  SUPPLEMENTAL: 'Supplements',
}
const DOC_ORDER = { COMMON_APP: 0, UC_PIQ: 1, SUPPLEMENTAL: 2 }

// A student's in-app markdown essays as file-list entries, for the developer
// Students-tab Files view (the essays live in Supabase, so the Drive/local file
// listing never saw them — this is what surfaces them there). Read-only: it
// does NOT materialize docs/tabs. Returns one entry per doc that actually has
// tabs (an empty doc — e.g. a UC PIQ doc before any prompts are chosen — is
// skipped so the list shows no hollow rows). `modified` = the doc's most recent
// tab edit, falling back to the doc's creation time. [] on any failure.
export async function listWritingDocEntries(supabase, studentSheetId) {
  if (!supabase || !studentSheetId) return []
  try {
    const { data: docs } = await supabase
      .from(MD_DOCUMENTS)
      .select('id,doc_type,created_at')
      .eq('student_sheet_id', studentSheetId)
    if (!docs?.length) return []

    const { data: tabs } = await supabase
      .from(MD_TABS)
      .select('document_id,updated_at')
      .in('document_id', docs.map((d) => d.id))
    const tabsByDoc = new Map()
    for (const t of tabs || []) {
      const arr = tabsByDoc.get(t.document_id) || []
      arr.push(t)
      tabsByDoc.set(t.document_id, arr)
    }

    return docs
      .map((d) => {
        const dtabs = tabsByDoc.get(d.id) || []
        const modified = dtabs.reduce(
          (m, t) => (t.updated_at && t.updated_at > m ? t.updated_at : m),
          d.created_at
        )
        return {
          docId: d.id,
          docType: d.doc_type,
          label: DOC_LABEL[d.doc_type] || 'Essay',
          tabCount: dtabs.length,
          modified: modified || null,
        }
      })
      .filter((e) => e.tabCount > 0)
      .sort((a, b) => (DOC_ORDER[a.docType] ?? 9) - (DOC_ORDER[b.docType] ?? 9))
  } catch {
    return []
  }
}

// ── Documents ─────────────────────────────────────────────────────────────────
// Ensure the 3 logical docs exist for a student; returns a map docType → row.
export async function ensureDocuments(supabase, studentSheetId, studentEmail) {
  const { data: existing } = await supabase
    .from(MD_DOCUMENTS)
    .select('id,doc_type')
    .eq('student_sheet_id', studentSheetId)
  const byType = {}
  for (const d of existing || []) byType[d.doc_type] = d

  const missing = DOC_TYPES.filter((t) => !byType[t])
  if (missing.length) {
    const { data: created } = await supabase
      .from(MD_DOCUMENTS)
      .upsert(
        missing.map((doc_type) => ({
          student_sheet_id: studentSheetId,
          student_email: studentEmail || '',
          doc_type,
        })),
        { onConflict: 'student_sheet_id,doc_type', ignoreDuplicates: false }
      )
      .select('id,doc_type')
    for (const d of created || []) byType[d.doc_type] = d
  }
  return byType
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
const REGION_RANK = { active: 0, manual_active: 1, orphaned: 2 }

export async function listTabsOrdered(supabase, documentId) {
  const { data } = await supabase
    .from(MD_TABS)
    .select('id,title,origin,sync_key,sync_state,sort_key,created_at')
    .eq('document_id', documentId)
  const tabs = data || []
  tabs.sort(
    (a, b) =>
      (REGION_RANK[a.sync_state] ?? 1) - (REGION_RANK[b.sync_state] ?? 1) ||
      a.sort_key - b.sort_key ||
      String(a.created_at).localeCompare(String(b.created_at))
  )
  return tabs
}

// Create rev 0 (empty or seeded) for a tab if it has no revisions yet. Baseline
// is attributed to the STUDENT (it's their blank doc), not whoever triggered it.
async function ensureBaseline(supabase, tabId, student, seedBody) {
  const { count } = await supabase
    .from(MD_TAB_REVISIONS)
    .select('id', { count: 'exact', head: true })
    .eq('tab_id', tabId)
  if (count && count > 0) return
  await supabase.from(MD_TAB_REVISIONS).insert({
    tab_id: tabId,
    revision: 0,
    body_md: seedBody || '',
    source: 'baseline',
    editor_email: student.email || 'student@portal',
    editor_role: 'student',
    editor_name: student.name || 'Student',
    note: 'Original',
  })
}

// Idempotent, non-destructive sync of the SYNCED tabs in a document against an
// ordered list of entries [{ key, title, seed? }] (already deduped by key).
// - add: entry with no matching tab → create active tab at its list index
// - keep: matching tab → ensure active + sort=index; NEVER overwrite the title
// - orphan: synced tab whose key left the list → move to bottom, content kept
// Manual tabs are never touched. A second run with the same list is a no-op.
export async function syncTabs(supabase, documentId, entries, student) {
  const existing = await listTabsOrdered(supabase, documentId)
  const byKey = new Map()
  for (const t of existing) {
    if (t.origin === 'synced' && t.sync_key) byKey.set(t.sync_key, t)
  }

  // dedup entries by key, first occurrence wins
  const seen = new Set()
  const list = []
  for (const e of entries) {
    const key = e.key
    if (!key || seen.has(key)) continue
    seen.add(key)
    list.push(e)
  }

  // Pass A — ensure each current entry has an active tab at its index.
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    let tab = byKey.get(e.key)
    if (!tab) {
      const { data, error } = await supabase
        .from(MD_TABS)
        .insert({
          document_id: documentId,
          title: e.title || e.key,
          origin: 'synced',
          sync_key: e.key,
          sync_state: 'active',
          sort_key: i,
        })
        .select('id,title,sync_state,sort_key')
        .single()
      if (error) {
        // 23505 → a concurrent sync created it; adopt the existing row.
        if (error.code === '23505') {
          const { data: row } = await supabase
            .from(MD_TABS)
            .select('id,title,sync_state,sort_key')
            .eq('document_id', documentId)
            .eq('sync_key', e.key)
            .single()
          tab = row
        } else {
          continue
        }
      } else {
        tab = data
      }
      if (tab) byKey.set(e.key, tab)
    }
    if (tab && (tab.sync_state !== 'active' || tab.sort_key !== i)) {
      await supabase
        .from(MD_TABS)
        .update({ sync_state: 'active', sort_key: i })
        .eq('id', tab.id)
    }
    // ensure baseline even if the tab pre-existed without revisions
    if (tab) await ensureBaseline(supabase, tab.id, student, e.seed)
  }

  // Pass B — orphan synced tabs whose key is gone (move to bottom, keep content).
  const orphanKeys = existing
    .filter((t) => t.sync_state === 'orphaned')
    .map((t) => t.sort_key)
  let nextOrphan = Math.max(list.length, ...orphanKeys, -1) + 1
  for (const t of existing) {
    if (t.origin !== 'synced' || !t.sync_key) continue
    if (!seen.has(t.sync_key) && t.sync_state !== 'orphaned') {
      await supabase
        .from(MD_TABS)
        .update({ sync_state: 'orphaned', sort_key: nextOrphan++ })
        .eq('id', t.id)
    }
  }
}

// Ensure a single-tab document (Common App) has exactly its one tab.
export async function ensureSingletonTab(supabase, documentId, title, student) {
  const tabs = await listTabsOrdered(supabase, documentId)
  if (tabs.length) {
    await ensureBaseline(supabase, tabs[0].id, student, '')
    return tabs[0]
  }
  const { data } = await supabase
    .from(MD_TABS)
    .insert({
      document_id: documentId,
      title,
      origin: 'manual',
      sync_state: 'manual_active',
      sort_key: 0,
    })
    .select('id')
    .single()
  if (data) await ensureBaseline(supabase, data.id, student, '')
  return data
}

// A document's owning student + type (for ownership checks on the tab routes).
export async function docContext(supabase, documentId) {
  const { data } = await supabase
    .from(MD_DOCUMENTS)
    .select('id,student_sheet_id,doc_type')
    .eq('id', documentId)
    .single()
  return data || null
}

// Manually add a tab (user action). Lands in the 'manual' region, after the
// active tabs. Seeds an empty baseline attributed to the student.
export async function createManualTab(supabase, documentId, title, student) {
  const tabs = await listTabsOrdered(supabase, documentId)
  const maxSort = tabs.reduce((m, t) => Math.max(m, t.sort_key), -1)
  const { data } = await supabase
    .from(MD_TABS)
    .insert({
      document_id: documentId,
      title: String(title || 'Untitled').slice(0, 120) || 'Untitled',
      origin: 'manual',
      sync_state: 'manual_active',
      sort_key: maxSort + 1,
    })
    .select('id,title')
    .single()
  if (data) await ensureBaseline(supabase, data.id, student, '')
  return data
}

export async function renameTab(supabase, tabId, title) {
  await supabase
    .from(MD_TABS)
    .update({ title: String(title || '').slice(0, 120) || 'Untitled' })
    .eq('id', tabId)
}

// Set sort order from an explicit id list (drag reorder). Region ranking still
// applies on read, so this orders tabs within their region.
export async function reorderTabs(supabase, documentId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    await supabase
      .from(MD_TABS)
      .update({ sort_key: i })
      .eq('id', orderedIds[i])
      .eq('document_id', documentId)
  }
}

// ── Revisions ─────────────────────────────────────────────────────────────────
// The tab's owning student sheet id (for ownership checks), or null if unknown.
export async function tabContext(supabase, tabId) {
  const { data } = await supabase
    .from(MD_TABS)
    .select('id,title,document_id,md_documents(student_sheet_id,doc_type)')
    .eq('id', tabId)
    .single()
  if (!data) return null
  return {
    tabId: data.id,
    title: data.title,
    documentId: data.document_id,
    studentSheetId: data.md_documents?.student_sheet_id || null,
    docType: data.md_documents?.doc_type || null,
  }
}

export async function getTabBody(supabase, tabId, revision) {
  let q = supabase
    .from(MD_TAB_REVISIONS)
    .select('revision,body_md,source,editor_name,editor_role,created_at')
    .eq('tab_id', tabId)
  q =
    revision != null
      ? q.eq('revision', Number(revision))
      : q.order('revision', { ascending: false }).limit(1)
  const { data } = await q
  return data?.[0] || null
}

export async function getTabHistory(supabase, tabId) {
  const { data } = await supabase
    .from(MD_TAB_REVISIONS)
    .select('revision,source,note,editor_name,editor_role,created_at')
    .eq('tab_id', tabId)
    .order('revision', { ascending: false })
  return data || []
}

// Append a new revision (becomes canonical). editor = { email, role, name }.
// MAX(revision)+1 with a single 23505 retry, mirroring the HTML editor route.
export async function appendRevision(supabase, tabId, bodyMd, editor, source, note) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: top } = await supabase
      .from(MD_TAB_REVISIONS)
      .select('revision')
      .eq('tab_id', tabId)
      .order('revision', { ascending: false })
      .limit(1)
    const nextRevision = (top?.[0]?.revision ?? -1) + 1
    const { error } = await supabase.from(MD_TAB_REVISIONS).insert({
      tab_id: tabId,
      revision: nextRevision,
      body_md: String(bodyMd ?? ''),
      source: source || 'edit',
      editor_email: editor.email,
      editor_role: editor.role === 'admin' ? 'admin' : 'student',
      editor_name: editor.name || null,
      note: note ? String(note).slice(0, 500) : null,
    })
    if (!error) return { revision: nextRevision }
    if (error.code !== '23505') return { error: 'Save failed' }
  }
  return { error: 'Save conflict, try again', conflict: true }
}

// ── College list (from the Supabase mirror) → sync entries ───────────────────
// Build the ordered sync entries for each doc from a mirrored payload (the
// parseCollegeGrid output). Returns { supplemental:[], piq:[] }.
export function entriesFromCollegeList(payload) {
  const schools = Array.isArray(payload?.schools) ? payload.schools : []
  const piqs = Array.isArray(payload?.piqs) ? payload.piqs : []
  const supplemental = schools
    .map((s) => ({ key: normalizeKey(s.name), title: String(s.name || '').trim() }))
    .filter((e) => e.key)
  const piq = piqs
    .map((p, i) => ({ p, n: i + 1 }))
    .filter(({ p }) => p.chosen)
    .map(({ p, n }) => ({
      key: `piq-${n}`,
      title: `PIQ ${n}`,
      seed: p.prompt ? `> ${String(p.prompt).trim()}\n\n` : '',
    }))
  return { supplemental, piq }
}
