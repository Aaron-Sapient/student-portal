import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'
import { getSupabaseClient } from '@/lib/supabase'
import { readMode, logShadow } from '@/lib/readFlags'

// Single source of truth for "who is this email" against the Master Sheet.
// Roles: 'student' (col J match), 'parent' (col K/L match), or null.
// A student match always wins — an email living in both J and K/L is a student.

const MASTER_TAB = "'👩‍🎓 All Data'"

export function normEmail(v) {
  return String(v ?? '').trim().toLowerCase()
}

export function sessionEmail(sessionClaims) {
  return sessionClaims?.email ?? sessionClaims?.primary_email_address ?? null
}

function sheetIdFromPortalUrl(url) {
  const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/)
  return m ? m[1] : null
}

// masterRows = values from "'👩‍🎓 All Data'!A:BD".
// Cols: A=0 name, B=1 class/grade, G=6 portal URL, J=9 student email,
// K=10 parent email 1, L=11 parent email 2.
// Class "NC" = not counseling: the row grants NO portal identity — the student
// can't sign in and the child never appears in a parent's switcher.
const isNC = (r) => String(r?.[1] ?? '').trim().toUpperCase() === 'NC'

export function classifyEmail(masterRows, email) {
  const target = normEmail(email)
  if (!target || !target.includes('@')) return { role: null }

  const studentRow = masterRows.find(
    (r) => normEmail(r?.[9]) === target && !isNC(r)
  )
  if (studentRow) return { role: 'student', studentRow }

  const children = []
  masterRows.forEach((r, i) => {
    if (isNC(r)) return
    const slot =
      normEmail(r?.[10]) === target ? 1 : normEmail(r?.[11]) === target ? 2 : 0
    if (!slot) return
    const sheetId = sheetIdFromPortalUrl(r?.[6])
    if (!sheetId) return // row without a usable portal URL can't be served
    children.push({
      name: String(r?.[0] ?? '').trim(),
      grade: String(r?.[1] ?? '').trim(),
      sheetId,
      rowIndex: i,
      parentSlot: slot,
    })
  })
  if (children.length) return { role: 'parent', children }

  return { role: null }
}

// The Master roster (A:BD) is read by resolveIdentity on EVERY parent-portal
// request — the layout's role gate plus each /api/parent/* call's requireParent.
// A single parent page load fans those out 4-6× in the same second, and the
// service account shares a ~60 reads/min Sheets quota across the whole app, so
// uncached this path alone trips "Read requests per minute per user". Cache the
// raw rows in-process with a short TTL, and stash the in-flight promise so a
// burst of concurrent requests coalesces into ONE Sheets read instead of each
// racing its own. Lives on globalThis because route bundles compile with
// separate module scopes (same reason as the dev scores cache). The roster
// changes rarely (new students added now and then), so 30s is plenty fresh.
const ROSTER_CACHE_MS = 30 * 1000
const rosterCache = (globalThis.__masterRosterCache ??= {
  at: 0,
  rows: null,
  inflight: null,
})

async function loadMasterRows(sheets) {
  if (rosterCache.rows && Date.now() - rosterCache.at < ROSTER_CACHE_MS) {
    return rosterCache.rows
  }
  if (rosterCache.inflight) return rosterCache.inflight
  rosterCache.inflight = (async () => {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.MASTER_SHEET_ID,
        range: `${MASTER_TAB}!A:BD`,
      })
      rosterCache.rows = res.data.values || []
      rosterCache.at = Date.now()
      return rosterCache.rows
    } finally {
      rosterCache.inflight = null
    }
  })()
  return rosterCache.inflight
}

async function resolveIdentityFromSheets(sheets, email) {
  const rows = await loadMasterRows(sheets)
  return classifyEmail(rows, email)
}

// ── Supabase reader (migration target — tables `students` + `guardians`) ────
// Reconstructs exactly the shape classifyEmail returns. `studentRow` is a sparse
// array populated at the indices the only consumer reads (writingAuth: [0] name,
// [6] portal URL); [1] class and [9] email are filled for safety. `children` carry
// {name, grade(=class), sheetId, parentSlot, rowIndex:null} — consumers use only
// name/grade/sheetId (parent/layout) and sheetId (writingAuth/requireParent); no
// consumer reads rowIndex/parentSlot (verified). student wins over parent, exactly
// like classifyEmail. NC students are status='nc' → excluded, matching isNC().
function rowFromStudent(s) {
  const row = []
  row[0] = s.name
  row[1] = s.class
  row[6] = s.portal_url
  row[9] = s.student_email
  return row
}

async function resolveIdentityFromSupabase(email) {
  const target = normEmail(email)
  if (!target || !target.includes('@')) return { role: null }
  const sb = getSupabaseClient()

  const { data: studs, error: sErr } = await sb
    .from('students')
    .select('student_sheet_id, name, class, student_email, portal_url, status')
    .eq('student_email', target)
    .eq('status', 'active')
    .limit(1)
  if (sErr) {
    console.warn(`[roster:supabase] student query failed: ${sErr.message}`)
    return { role: null }
  }
  if (studs && studs.length) return { role: 'student', studentRow: rowFromStudent(studs[0]) }

  const { data: guards, error: gErr } = await sb
    .from('guardians')
    .select('ordinal, student_sheet_id, students(name, class, status)')
    .eq('email', target)
  if (gErr) {
    console.warn(`[roster:supabase] guardian query failed: ${gErr.message}`)
    return { role: null }
  }
  const children = (guards || [])
    .filter((g) => g.students && g.students.status === 'active')
    .map((g) => ({
      name: String(g.students.name ?? '').trim(),
      grade: String(g.students.class ?? '').trim(),
      sheetId: g.student_sheet_id,
      rowIndex: null,
      parentSlot: g.ordinal,
    }))
  if (children.length) return { role: 'parent', children }

  return { role: null }
}

const sheetIdFromStudentRow = (row) => sheetIdFromPortalUrl(row?.[6])

// shadow comparator: returns diff strings (empty ⇒ match). Compares the surface
// consumers actually read — role, student name+sheetId, parent's child sheetIds.
function diffIdentity(a, b) {
  const diffs = []
  const ra = a?.role ?? null
  const rb = b?.role ?? null
  if (ra !== rb) {
    diffs.push(`role ${ra}≠${rb}`)
    return diffs
  }
  if (ra === 'student') {
    const na = String(a.studentRow?.[0] ?? '').trim()
    const nb = String(b.studentRow?.[0] ?? '').trim()
    if (na !== nb) diffs.push(`name "${na}"≠"${nb}"`)
    if (sheetIdFromStudentRow(a.studentRow) !== sheetIdFromStudentRow(b.studentRow))
      diffs.push(`sheetId ${sheetIdFromStudentRow(a.studentRow)}≠${sheetIdFromStudentRow(b.studentRow)}`)
  } else if (ra === 'parent') {
    const ka = (a.children || []).map((c) => c.sheetId).sort()
    const kb = (b.children || []).map((c) => c.sheetId).sort()
    if (JSON.stringify(ka) !== JSON.stringify(kb)) diffs.push(`children [${ka}]≠[${kb}]`)
  }
  return diffs
}

// Reads from Sheets, Supabase, or both per the `roster` read flag (lib/readFlags.js).
// Default `off` ⇒ Sheets, unchanged. shadow reads both, logs diffs, returns Sheets.
export async function resolveIdentity(sheets, email) {
  const mode = readMode('roster')
  if (mode === 'on') return resolveIdentityFromSupabase(email)
  if (mode === 'shadow') {
    const [sheetRes, supaRes] = await Promise.all([
      resolveIdentityFromSheets(sheets, email),
      resolveIdentityFromSupabase(email).catch((e) => {
        console.warn(`[shadow:roster] ${normEmail(email)} supabase read threw: ${e?.message}`)
        return { role: null }
      }),
    ])
    logShadow('roster', normEmail(email) || '(none)', diffIdentity(sheetRes, supaRes))
    return sheetRes // shadow ALWAYS returns the authoritative Sheets answer
  }
  return resolveIdentityFromSheets(sheets, email)
}

// Reverse lookup: a student's { name, email, sheetId } from their sheet id.
// Used by the writing routes when an admin (Aaron/Ryan) edits a specific
// student's docs (?student=<sheetId>) — the sheet id carries no email/name by
// itself. Reads the cached roster, so no extra Sheets quota on the hot path.
async function studentBySheetIdFromSheets(sheets, sheetId) {
  if (!sheetId) return null
  const rows = await loadMasterRows(sheets)
  for (const r of rows) {
    if (isNC(r)) continue
    if (sheetIdFromPortalUrl(r?.[6]) === sheetId) {
      return {
        name: String(r?.[0] ?? '').trim(),
        email: normEmail(r?.[9]),
        sheetId,
      }
    }
  }
  return null
}

async function studentBySheetIdFromSupabase(sheetId) {
  if (!sheetId) return null
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from('students')
    .select('name, student_email, status')
    .eq('student_sheet_id', sheetId)
    .eq('status', 'active') // NC excluded, matching the Sheets isNC() skip
    .limit(1)
  if (error) {
    console.warn(`[roster:supabase] studentBySheetId failed: ${error.message}`)
    return null
  }
  if (!data || !data.length) return null
  return { name: String(data[0].name ?? '').trim(), email: normEmail(data[0].student_email), sheetId }
}

export async function studentBySheetId(sheets, sheetId) {
  const mode = readMode('roster')
  if (mode === 'on') return studentBySheetIdFromSupabase(sheetId)
  if (mode === 'shadow') {
    const [sheetRes, supaRes] = await Promise.all([
      studentBySheetIdFromSheets(sheets, sheetId),
      studentBySheetIdFromSupabase(sheetId).catch(() => null),
    ])
    const diffs = []
    if ((sheetRes?.name ?? null) !== (supaRes?.name ?? null))
      diffs.push(`name ${sheetRes?.name}≠${supaRes?.name}`)
    if ((sheetRes?.email ?? null) !== (supaRes?.email ?? null))
      diffs.push(`email ${sheetRes?.email}≠${supaRes?.email}`)
    logShadow('roster', `byId:${sheetId}`, diffs)
    return sheetRes
  }
  return studentBySheetIdFromSheets(sheets, sheetId)
}

// ── Roster list (the whole student body) ────────────────────────────────────
// The dev surfaces (Scoring spot-check, Students cards, the Writing picker) need
// EVERY student as { name, grade(=Class cell), classYear, sheetId } — a list, not
// the email→identity lookup resolveIdentity does. Different shape, same data, so it
// rides the SAME `roster` flag. classYear = the 4-digit grad year parsed from the
// Class cell ("'27" → 2027); grade keeps the raw cell for back-compat.
function classYearFromClass(klass) {
  const m = String(klass ?? '').match(/(\d{2})\s*$/)
  return m ? 2000 + Number(m[1]) : null
}

// Sheets path: ONE Master A:G read (name A, class B, portal URL G), parsed exactly
// like the dev dashboard's old listRoster — a row is a student iff it has a name AND
// a parseable portal URL. (NC rows are NOT filtered on this surface; they never were,
// and the parity check below confirms Supabase agrees.) Its own read, not the A:BD
// roster cache, so flag=off stays byte-for-byte the prior behavior.
async function listStudentsFromSheets(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: `${MASTER_TAB}!A:G`,
  })
  const out = []
  for (const r of (res.data.values || []).slice(1)) {
    const name = String(r?.[0] ?? '').trim()
    const sheetId = sheetIdFromPortalUrl(r?.[6])
    if (!name || !sheetId) continue
    const klass = String(r?.[1] ?? '').trim()
    out.push({ name, grade: klass, classYear: classYearFromClass(klass), sheetId })
  }
  return out
}

// Supabase path: the `students` mirror. student_sheet_id IS the portal-URL sheetId
// (the PK convention), so it maps straight across. No status filter — listRoster
// never dropped NC rows. NC is stored as status='nc' with an empty `class`, but the
// Sheet's Class cell literally reads "NC", so we reconstruct that label to keep the
// `grade` string byte-identical (parity-verified by shadowCompareRosterList.cjs).
async function listStudentsFromSupabase() {
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from('students')
    .select('student_sheet_id, name, class, status')
  if (error) {
    console.warn(`[roster:supabase] listStudents failed: ${error.message}`)
    return []
  }
  return (data || [])
    .filter((s) => String(s.name ?? '').trim() && s.student_sheet_id)
    .map((s) => {
      const klass = s.status === 'nc' ? 'NC' : String(s.class ?? '').trim()
      return {
        name: String(s.name).trim(),
        grade: klass,
        classYear: classYearFromClass(klass),
        sheetId: s.student_sheet_id,
      }
    })
}

// shadow comparator: diff the two rosters by sheetId (presence + name + grade).
function diffStudentList(a, b) {
  const diffs = []
  const mapA = new Map(a.map((s) => [s.sheetId, s]))
  const mapB = new Map(b.map((s) => [s.sheetId, s]))
  for (const id of mapA.keys()) if (!mapB.has(id)) diffs.push(`supa missing ${id}`)
  for (const id of mapB.keys()) if (!mapA.has(id)) diffs.push(`supa extra ${id}`)
  for (const [id, sa] of mapA) {
    const sb = mapB.get(id)
    if (!sb) continue
    if (String(sa.name) !== String(sb.name)) diffs.push(`name@${id} "${sa.name}"≠"${sb.name}"`)
    if (String(sa.grade) !== String(sb.grade)) diffs.push(`grade@${id} ${sa.grade}≠${sb.grade}`)
  }
  return diffs
}

// Whole-roster list per the `roster` flag (lib/readFlags.js). Default off ⇒ Sheets,
// unchanged. shadow reads both, logs diffs, returns the Sheets answer. on ⇒ Supabase.
export async function listStudents(sheets) {
  const mode = readMode('roster')
  if (mode === 'on') return listStudentsFromSupabase()
  if (mode === 'shadow') {
    const [sheetRes, supaRes] = await Promise.all([
      listStudentsFromSheets(sheets),
      listStudentsFromSupabase().catch((e) => {
        console.warn(`[shadow:roster] listStudents supabase read threw: ${e?.message}`)
        return []
      }),
    ])
    logShadow('roster', 'listStudents', diffStudentList(sheetRes, supaRes))
    return sheetRes // shadow ALWAYS returns the authoritative Sheets answer
  }
  return listStudentsFromSheets(sheets)
}

// Guard for /api/parent/* routes. Authenticates, resolves the parent, and
// validates the ?student=<sheetId> selector against the parent's OWN children —
// the sheet id carries no authority by itself. Returns either { error } (a
// ready-to-return Response) or { email, children, child, sheets }.
export async function requireParent(request) {
  const { userId, sessionClaims } = await auth()
  if (!userId) {
    return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const email = sessionEmail(sessionClaims)
  // quotaUser: each parent gets their own Sheets read-quota bucket.
  const sheets = getGoogleSheetsClient(email)
  const identity = await resolveIdentity(sheets, email)
  if (identity.role !== 'parent' || !identity.children.length) {
    return { error: Response.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  const requested = new URL(request.url).searchParams.get('student')
  const child = requested
    ? identity.children.find((c) => c.sheetId === requested)
    : identity.children[0]
  if (!child) {
    return { error: Response.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { email, children: identity.children, child, sheets }
}

// Cheap role read for layouts/redirects — no Sheets call. Reads the session
// token's `role` claim (Clerk dashboard: Sessions → Customize session token →
// add "role": "{{user.public_metadata.role}}"), falling back to publicMetadata
// for sessions minted before the claim existed.
export async function getSessionRole() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return null
  if (sessionClaims?.role) return sessionClaims.role
  try {
    const { clerkClient } = await import('@clerk/nextjs/server')
    const client = await clerkClient()
    const user = await client.users.getUser(userId)
    return user?.publicMetadata?.role ?? null
  } catch {
    return null
  }
}
