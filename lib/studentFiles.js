import { auth } from '@clerk/nextjs/server'
import { normEmail, sessionEmail } from '@/lib/identity'
import { ADMIN_EMAILS } from '@/lib/developerAuth'
import { getSupabaseClient, DOCUMENTS, DOCUMENT_EDITS, DOCUMENTS_BUCKET } from '@/lib/supabase'

// Student file delivery — the consultant design adopted verbatim on 2026-08-27
// (Clauni/briefs/2026-08-27-A4-consultant-file-system.md). One `documents` row per
// file per student: html/markdown bodies in the row, pdf / >1 MB in the private
// `documents` Storage bucket. A student's own edits live in `document_edits`
// (one row per document; the original is only ever written by the push script).
// Who may see what is decided in exactly ONE server-side function: canAccess().
//
// Google Drive and the local "Student Profiles" folder scan that used to feed
// this module are deleted, not migrated (.claude/CLAUDE.md, consequence (e)).
//
// Parent ↔ student link: the existing `guardians` table (student_sheet_id, email,
// ordinal) stands in for the brief's `student_guardians` — same two facts, already
// populated, already what the parent portal resolves through.

const DOC_COLUMNS = 'id, student_id, slug, title, kind, storage_path, editable, pushed_at, pushed_by'
const SIGNED_URL_SECONDS = 10 * 60

// ── The one gate ─────────────────────────────────────────────────────────────

function isStaff(email) {
  return ADMIN_EMAILS.includes(normEmail(email))
}

// Every student uuid this email may see: their own row (student) plus every
// child attached through `guardians` (parent). Staff are handled before this runs.
async function accessibleStudentIds(supabase, email) {
  const target = normEmail(email)
  if (!target || !target.includes('@')) return []
  const ids = new Set()

  const { data: own, error: ownErr } = await supabase
    .from('students')
    .select('id')
    .eq('student_email', target)
    .eq('status', 'active')
  if (ownErr) throw new Error(`students lookup failed: ${ownErr.message}`)
  for (const s of own || []) ids.add(s.id)

  const { data: kids, error: kidErr } = await supabase
    .from('guardians')
    .select('students(id, status)')
    .eq('email', target)
  if (kidErr) throw new Error(`guardians lookup failed: ${kidErr.message}`)
  for (const g of kids || []) {
    if (g.students?.id && g.students.status === 'active') ids.add(g.students.id)
  }
  return [...ids]
}

// canAccess(email, document) → { read: boolean, write: boolean }.
//   staff   read every row, write every row
//   student read own rows, write only document_edits on own rows where editable
//   parent  read the attached student's rows, write nothing
export async function canAccess(email, document) {
  if (!document?.student_id) return { read: false, write: false }
  if (isStaff(email)) return { read: true, write: true }
  const supabase = getSupabaseClient()
  const target = normEmail(email)
  const ids = await accessibleStudentIds(supabase, target)
  if (!ids.includes(document.student_id)) return { read: false, write: false }
  const { data: own } = await supabase
    .from('students')
    .select('id')
    .eq('id', document.student_id)
    .eq('student_email', target)
    .maybeSingle()
  const isOwner = Boolean(own?.id)
  return { read: true, write: isOwner && Boolean(document.editable) }
}

// ── Session helpers ──────────────────────────────────────────────────────────

// Returns { error } (a ready-to-return Response) or { email }.
export async function requireSessionEmail() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  const email = normEmail(sessionEmail(sessionClaims))
  if (!email) return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  return { email }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getDocument(id) {
  const uuid = String(id || '')
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return null
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from(DOCUMENTS)
    .select(`${DOC_COLUMNS}, body`)
    .eq('id', uuid)
    .maybeSingle()
  if (error) throw new Error(`documents read failed: ${error.message}`)
  return data || null
}

async function listRowsForStudentIds(supabase, studentIds) {
  if (!studentIds.length) return []
  const { data, error } = await supabase
    .from(DOCUMENTS)
    .select(`${DOC_COLUMNS}, students(name, slug)`)
    .in('student_id', studentIds)
    .order('pushed_at', { ascending: false })
  if (error) throw new Error(`documents list failed: ${error.message}`)
  return data || []
}

// The Files-tab row shape (unchanged contract with app/(portal)/files/FilesView.js):
// id / source / isReport / isEditable / name / filename / kind / ext / modified /
// size / openUrl. Editable rows open the in-portal editor for the owning student;
// everyone else (parents, staff) renders them read-only through /api/files/<id>,
// which serves the student's working copy when one exists.
const KIND_EXT = { html: 'html', markdown: 'md', pdf: 'pdf' }
export function toFileRow(row, { editableInteractive = false } = {}) {
  const ext = KIND_EXT[row.kind] || ''
  const editable = Boolean(row.editable)
  return {
    id: row.id,
    source: 'portal',
    isReport: true,
    isEditable: editable && editableInteractive,
    name: row.title || row.slug,
    filename: row.slug,
    kind: row.kind === 'pdf' ? 'pdf' : 'doc',
    ext,
    modified: row.pushed_at || null,
    size: null,
    studentName: row.students?.name || null,
    openUrl:
      editable && editableInteractive
        ? `/edit?file=${encodeURIComponent(row.id)}`
        : `/api/files/${encodeURIComponent(row.id)}`,
  }
}

// Every document this email may read. Students get their own; parents get their
// attached students'; staff get everything (or one student's via `studentId`).
// `studentId` narrows the result to one student in every role — for a
// non-staff caller it is intersected with what they may see, never trusted.
export async function listDocumentsFor(email, { studentId = null } = {}) {
  const supabase = getSupabaseClient()
  let ids
  if (isStaff(email)) {
    if (studentId) ids = [studentId]
    else {
      const { data, error } = await supabase.from('students').select('id')
      if (error) throw new Error(`students list failed: ${error.message}`)
      ids = (data || []).map((s) => s.id)
    }
  } else {
    ids = await accessibleStudentIds(supabase, email)
    if (studentId) ids = ids.filter((id) => id === studentId)
  }
  const rows = await listRowsForStudentIds(supabase, ids)
  // Only the owning STUDENT gets the interactive editor.
  const ownerIds = new Set()
  if (!isStaff(email)) {
    const { data: own } = await supabase
      .from('students')
      .select('id')
      .eq('student_email', normEmail(email))
    for (const s of own || []) ownerIds.add(s.id)
  }
  return rows.map((r) => toFileRow(r, { editableInteractive: ownerIds.has(r.student_id) }))
}

// students.id from the sheet-id key the rest of the portal still carries around
// (requireParent's `child.sheetId`, the developer panel's `?sheetId=`).
export async function studentIdFromSheetId(studentSheetId) {
  if (!studentSheetId) return null
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('students')
    .select('id, name')
    .eq('student_sheet_id', studentSheetId)
    .maybeSingle()
  if (error) throw new Error(`students lookup failed: ${error.message}`)
  return data || null
}

// ── Render ───────────────────────────────────────────────────────────────────

// Counselor-authored HTML renders on the portal's own origin, which is also its
// danger: without a sandbox a document served here runs with the viewer's Clerk
// session and can call every API they're authorized for. The sandbox directive
// drops the document into an opaque origin — no cookies, no same-origin fetch, no
// portal localStorage. The three allow-* tokens are the minimum that keeps real
// reports working, and NONE of them is `allow-same-origin`:
//   allow-scripts .............. the interactive project hubs run JS
//   allow-popups (+escape) ..... source links with target="_blank"
//   allow-top-navigation-by-user-activation ... plain <a href> source links,
//                                              on a real click only, never scripted
const RENDER_SANDBOX =
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation'

const KIND_MIME = {
  html: 'text/html; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  pdf: 'application/pdf',
}

// The text a viewer should see for a document: the student's working copy for an
// editable row when one exists, else the pushed original (§5 of the brief).
export async function currentBody(document) {
  if (document.editable) {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase
      .from(DOCUMENT_EDITS)
      .select('body, edited_at, edited_by')
      .eq('document_id', document.id)
      .maybeSingle()
    if (error) throw new Error(`document_edits read failed: ${error.message}`)
    if (data) return { body: data.body, edited: true, edited_at: data.edited_at }
  }
  return { body: document.body, edited: false, edited_at: null }
}

// Web Response for one document the caller has ALREADY passed through canAccess:
// html/markdown inline from the row; pdf / bucket-resident bytes via a 302 to a
// short-lived signed URL (the bytes never pass through a function body).
export async function renderDocument(document) {
  const mime = KIND_MIME[document.kind] || 'application/octet-stream'
  const filename = `${document.slug}${KIND_EXT[document.kind] ? `.${KIND_EXT[document.kind]}` : ''}`.replace(/"/g, '')

  if (document.storage_path) {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUrl(document.storage_path, SIGNED_URL_SECONDS)
    if (error || !data?.signedUrl) {
      return new Response('This file is temporarily unavailable. Your other files are fine.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
      })
    }
    return Response.redirect(data.signedUrl, 302)
  }

  const { body } = await currentBody(document)
  return new Response(body ?? '', {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(document.kind === 'html' ? { 'Content-Security-Policy': RENDER_SANDBOX } : {}),
    },
  })
}

// ── Edit path (§5) ───────────────────────────────────────────────────────────

// Upsert the student's working copy. The caller has already required
// canAccess(...).write, which is only ever true for the owning student on an
// editable row (or staff). The pushed original is never touched here.
export async function saveEdit(document, body, editedBy) {
  const supabase = getSupabaseClient()
  const { error } = await supabase.from(DOCUMENT_EDITS).upsert(
    {
      document_id: document.id,
      body,
      edited_at: new Date().toISOString(),
      edited_by: normEmail(editedBy),
    },
    { onConflict: 'document_id' }
  )
  if (error) throw new Error(`document_edits upsert failed: ${error.message}`)
}
