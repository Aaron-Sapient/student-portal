import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'

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

export async function resolveIdentity(sheets, email) {
  const rows = await loadMasterRows(sheets)
  return classifyEmail(rows, email)
}

// Reverse lookup: a student's { name, email, sheetId } from their sheet id.
// Used by the writing routes when an admin (Aaron/Ryan) edits a specific
// student's docs (?student=<sheetId>) — the sheet id carries no email/name by
// itself. Reads the cached roster, so no extra Sheets quota on the hot path.
export async function studentBySheetId(sheets, sheetId) {
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
