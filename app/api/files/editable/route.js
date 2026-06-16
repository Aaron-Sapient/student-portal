import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'
import { normEmail, sessionEmail } from '@/lib/identity'
import { readEditableSource } from '@/lib/studentFiles'
import { getSupabaseClient, DOCUMENT_REVISIONS_TABLE } from '@/lib/supabase'
import { sanitizeDocumentHtml } from '@/lib/htmlSanitize'

// Resolve the signed-in student to their sheet id — same email → Master Sheet →
// portal-URL resolution the other files routes use. Returns { error } (a
// ready-to-return Response) or { userEmail, sheets, studentSheetId }.
async function resolveStudent() {
  const { userId, sessionClaims } = await auth()
  if (!userId) {
    return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const userEmail = sessionEmail(sessionClaims)
  const sheets = getGoogleSheetsClient(userEmail)
  const masterRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: "'👩‍🎓 All Data'!G:BD",
  })
  const studentRow = (masterRes.data.values || []).find(
    (row) => normEmail(row[3]) === normEmail(userEmail)
  )
  if (!studentRow) {
    return { error: Response.json({ error: 'Student not found' }, { status: 404 }) }
  }
  const sheetIdMatch = studentRow[0]?.match(/\/d\/([a-zA-Z0-9-_]+)/)
  if (!sheetIdMatch) {
    return { error: Response.json({ error: 'Invalid portal URL' }, { status: 400 }) }
  }
  return { userEmail, sheets, studentSheetId: sheetIdMatch[1] }
}

// Ensure a baseline (revision 0) exists for this document, capturing the
// counselor's original from Drive/local the first time. Returns true if the
// document is real and owned (baseline present or freshly captured), false if
// the filename isn't an editable file in this student's folder.
async function ensureBaseline(supabase, ctx, filename) {
  const { count } = await supabase
    .from(DOCUMENT_REVISIONS_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('student_sheet_id', ctx.studentSheetId)
    .eq('filename', filename)
  if (count && count > 0) return true

  // No rows yet — verify ownership by reading the original, and store it as rev 0.
  const original = await readEditableSource(ctx.sheets, ctx.studentSheetId, filename)
  if (original == null) return false
  await supabase.from(DOCUMENT_REVISIONS_TABLE).upsert(
    {
      student_sheet_id: ctx.studentSheetId,
      student_email: ctx.userEmail,
      filename,
      revision: 0,
      html: original,
      source: 'baseline',
      note: 'Original',
    },
    { onConflict: 'student_sheet_id,filename,revision', ignoreDuplicates: true }
  )
  return true
}

// GET /api/files/editable?file=<filename>[&revision=N]
// Returns the canonical (latest) HTML + revision history. With ?revision=N,
// returns that specific revision's HTML (for history viewing / restore).
export async function GET(request) {
  const ctx = await resolveStudent()
  if (ctx.error) return ctx.error

  const url = new URL(request.url)
  const filename = url.searchParams.get('file')
  const revisionParam = url.searchParams.get('revision')
  if (!filename) return Response.json({ error: 'Missing file' }, { status: 400 })

  const supabase = getSupabaseClient()
  const owned = await ensureBaseline(supabase, ctx, filename)
  if (!owned) return Response.json({ error: 'Not found' }, { status: 404 })

  // History metadata (no html, keeps the payload small), newest first.
  const { data: history, error: histErr } = await supabase
    .from(DOCUMENT_REVISIONS_TABLE)
    .select('revision,source,note,created_at')
    .eq('student_sheet_id', ctx.studentSheetId)
    .eq('filename', filename)
    .order('revision', { ascending: false })
  if (histErr) return Response.json({ error: 'Load failed' }, { status: 502 })

  // The target revision's html: a specific one if asked, else the canonical max.
  let q = supabase
    .from(DOCUMENT_REVISIONS_TABLE)
    .select('revision,source,note,html')
    .eq('student_sheet_id', ctx.studentSheetId)
    .eq('filename', filename)
  q =
    revisionParam != null
      ? q.eq('revision', Number(revisionParam))
      : q.order('revision', { ascending: false }).limit(1)
  const { data: target, error: targetErr } = await q
  if (targetErr || !target?.length) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  const current = target[0]

  return Response.json({
    filename,
    html: current.html,
    revision: current.revision,
    source: current.source,
    note: current.note,
    history: history || [],
  })
}

// POST /api/files/editable  body: { filename, html, note? }
// Sanitizes and saves the student's edit as a new revision (becomes canonical).
export async function POST(request) {
  const ctx = await resolveStudent()
  if (ctx.error) return ctx.error

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }
  const filename = body?.filename
  if (!filename || typeof body?.html !== 'string') {
    return Response.json({ error: 'Missing filename or html' }, { status: 400 })
  }
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null

  const supabase = getSupabaseClient()
  const owned = await ensureBaseline(supabase, ctx, filename)
  if (!owned) return Response.json({ error: 'Not found' }, { status: 404 })

  const html = sanitizeDocumentHtml(body.html)

  // Insert at max(revision)+1. The unique (sheet,filename,revision) constraint
  // guards against a racing duplicate; retry once if we lose the race.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: top } = await supabase
      .from(DOCUMENT_REVISIONS_TABLE)
      .select('revision')
      .eq('student_sheet_id', ctx.studentSheetId)
      .eq('filename', filename)
      .order('revision', { ascending: false })
      .limit(1)
    const nextRevision = (top?.[0]?.revision ?? -1) + 1

    const { error } = await supabase.from(DOCUMENT_REVISIONS_TABLE).insert({
      student_sheet_id: ctx.studentSheetId,
      student_email: ctx.userEmail,
      filename,
      revision: nextRevision,
      html,
      source: 'student',
      note,
    })
    if (!error) {
      return Response.json({ ok: true, revision: nextRevision })
    }
    // 23505 = unique_violation → someone else inserted; recompute and retry once.
    if (error.code !== '23505') {
      return Response.json({ error: 'Save failed' }, { status: 502 })
    }
  }
  return Response.json({ error: 'Save conflict, try again' }, { status: 409 })
}
