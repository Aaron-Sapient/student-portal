import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'
import { getSupabaseClient, STUDENT_PROFILES } from '@/lib/supabase'

// Single source of truth for "who is this email". Roles: 'student', 'parent', or
// null. A student match always wins — an email owning both a `students` row and a
// `guardians` row is a student.
//
// ZERO-GOOGLE (Package B, 2026-09-02). Supabase is the record of truth and Google
// is legacy input, never a runtime dependency (ruling 2026-08-27). The Master
// `👩‍🎓 All Data` reader, its 30s in-process row cache, the `roster` read flag and
// the shadow comparators are DELETED, not flipped — a flag whose off-position reads
// a sheet is exactly the migration crutch the ruling retires. There is no fallback:
// a Supabase read error now propagates, because the alternative is resolving a real
// user to role:null (a silent lockout) against a source that no longer has an owner.
//
// TWO SIGNATURES DELIBERATELY KEEP AN UNUSED `sheets` PARAMETER, both because the
// CALLER is owned by a lane that has not moved yet, and dropping the arg would drag
// that lane's files into this commit:
//   • requireParent()   — app/api/parent/colleges still calls fetchCollegeData(sheets,…);
//                         college lists are out of B/D/F scope.
//   • studentBySheetId() — app/api/writing/doc + lib/writingAuth; the /write collab
//                         editor is fenced (Aaron, 2026-08-27) and its diff must stay
//                         empty. Both are one-line deletions once those lanes move.

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

// ── Identity from `students` + `guardians` ──────────────────────────────────
// `studentRow` is a sparse array at the indices consumers read (writingAuth: [0]
// name, [6] portal URL; [1] class and [9] email filled for safety). `children`
// carry {name, grade(=class), sheetId, parentSlot, rowIndex:null} — consumers use
// only name/grade/sheetId (parent/layout) and sheetId (writingAuth/requireParent).
// Student wins over parent. NC students are status='nc' → excluded.
//
// The array shape is a legacy carrier, not a Sheets read: it exists because the
// remaining consumers index into it. It retires with them, not with this commit.
function rowFromStudent(s) {
  const row = []
  row[0] = s.name
  row[1] = s.class
  row[6] = s.portal_url
  row[9] = s.student_email
  // Master AY/BA/BC/BE — the check-in block the check-in + booking routes read
  // (home-data, validateBooking, getUpdateFormData, bookMeeting). Widened
  // 2026-08-27 (Package A step 0): without these every consumer past index 9 saw
  // `undefined` — ART status, check-in recency and the needs-checkin flag all
  // silently flipped. Timestamps arrive as ISO strings (parseSheetDate/toLADate
  // both accept ISO); the flags arrive as REAL booleans — compare `=== true`,
  // never `=== 'TRUE'` (that half of the old check is dead and was dropped).
  row[50] = s.last_ryan_checkin ?? null
  row[52] = s.last_aaron_checkin ?? null
  row[54] = s.art_eligible === true
  row[56] = s.needs_checkin ?? null // null ⇒ blank cell ⇒ still in the cadence
  return row
}

// Every `students` column an identity consumer reads. ONE list so resolveIdentity
// and the helpers below can never drift apart.
const STUDENT_COLS =
  'id, slug, student_sheet_id, name, class, grade, student_email, portal_url, status, ' +
  'last_ryan_checkin, last_aaron_checkin, art_eligible, needs_checkin'

// THE roster identity read. No flag, no Sheets fallback (ruling 2026-08-27).
export async function resolveIdentity(email) {
  const target = normEmail(email)
  if (!target || !target.includes('@')) return { role: null }
  const sb = getSupabaseClient()

  const { data: studs, error: sErr } = await sb
    .from('students')
    .select(STUDENT_COLS)
    .eq('student_email', target)
    .eq('status', 'active')
    // ORDER before LIMIT: without it Postgres may return any matching row, where
    // the retired Sheets path deterministically took the FIRST Master row. Zero
    // duplicate student_email values live today, so this keeps a latent defect
    // latent rather than fixing an active one.
    .order('student_sheet_id')
    .limit(1)
  // THROW (not return null) on a read error so a Supabase blip stays
  // distinguishable from a clean "email not in roster". A clean empty result is
  // authoritative.
  if (sErr) throw new Error(`student query failed: ${sErr.message}`)
  if (studs && studs.length) return { role: 'student', studentRow: rowFromStudent(studs[0]) }

  const { data: guards, error: gErr } = await sb
    .from('guardians')
    .select('ordinal, student_sheet_id, students(name, class, status)')
    .eq('email', target)
  if (gErr) throw new Error(`guardian query failed: ${gErr.message}`)
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

// The signed-in student's `students` row (all STUDENT_COLS), or null when the
// email owns no active student row (a parent, a stranger, an NC student —
// status='nc'). THROWS on a read error so a Supabase blip is never mistaken for
// "not a student".
//
// A NULL `student_email` can never match: the guard below rejects a blank target
// before the query runs. That is the lock keeping a pre-auth roster row (phase 2b,
// `student_sheet_id` = 'portal:<slug>') invisible to every session until the
// invite step stamps the email.
export async function getStudentByEmail(email) {
  const target = normEmail(email)
  if (!target || !target.includes('@')) return null
  const { data, error } = await getSupabaseClient()
    .from('students')
    .select(STUDENT_COLS)
    .eq('student_email', target)
    .eq('status', 'active')
    .order('student_sheet_id') // determinism — see resolveIdentity
    .limit(1)
  if (error) throw new Error(`student query failed: ${error.message}`)
  return data?.[0] ?? null
}

// Everything an OUTGOING EMAIL needs about a student, keyed by sheet id:
// { name, studentEmail, parentEmails }. Replaces the Master `A:L` scan that
// grantBooking / grantProjectMeeting / submitUpdateForm each ran to read col A
// (name), col J (student email) and cols K/L (parent emails).
//
// parentEmails come from `guardians` ordered by `ordinal`, which IS the K/L slot
// (guardians.ordinal 1 = col K, 2 = col L), so recipient ORDER is preserved. The
// Master pair was capped at two by the sheet's shape; this is not, and a family
// with three guardian rows now gets all three CC'd. That is the roster telling the
// truth, not a behavior regression.
//
// Returns null when no active student owns the id. NEVER throws — every caller is
// mid-grant with a token already written, so a lookup blip must not 500 a grant
// that half-happened; a null degrades to "send no email" the same way an
// unmatched Master row did.
export async function getStudentContactBySheetId(sheetId) {
  if (!sheetId) return null
  try {
    const sb = getSupabaseClient()
    const { data, error } = await sb
      .from('students')
      .select('name, student_email, status')
      .eq('student_sheet_id', sheetId)
      .eq('status', 'active')
      .limit(1)
    if (error) throw new Error(error.message)
    if (!data || !data.length) return null
    const { data: guards, error: gErr } = await sb
      .from('guardians')
      .select('email, ordinal')
      .eq('student_sheet_id', sheetId)
      .order('ordinal')
    if (gErr) throw new Error(gErr.message)
    return {
      name: String(data[0].name ?? '').trim(),
      studentEmail: String(data[0].student_email ?? '').trim(),
      parentEmails: (guards || [])
        .map((g) => String(g.email ?? '').trim())
        .filter((e) => e.includes('@')),
    }
  } catch (e) {
    console.warn(`[identity] getStudentContactBySheetId failed for ${sheetId}: ${e?.message}`)
    return null
  }
}

// The 🔎 Overview B2/C4 mirror: { display_name, current_year } or null.
// display_name is stored VERBATIM (Aasrith's trailing space included — see
// lib/checkinIdentity.js for why that spelling is load-bearing). NEVER throws and
// NEVER treats a missing row as fatal: every active student has a profile today,
// which is exactly why this degrade looks unnecessary and must exist anyway —
// treating a missing profile as fatal reproduces the Ryan Koo bug one storage
// layer over. Pair with studentDisplay() for the degraded name/grade.
export async function getStudentProfile(sheetId) {
  if (!sheetId) return null
  try {
    const { data, error } = await getSupabaseClient()
      .from(STUDENT_PROFILES)
      .select('display_name, current_year')
      .eq('student_sheet_id', sheetId)
      .limit(1)
    if (error) throw new Error(error.message)
    return data?.[0] ?? null
  } catch (e) {
    console.warn(`[identity] student_profiles read failed for ${sheetId}: ${e?.message}`)
    return null
  }
}

// "'27" → '12th' (the Overview C4 vocabulary), same season math as
// lib/scores.js gradeFromClass. Last-resort grade degrade when both
// student_profiles.current_year and students.grade are empty.
export function gradeLabelFromClass(klass) {
  const gradYear = classYearFromClass(klass)
  if (!gradYear) return null
  const now = new Date()
  const month = now.getMonth() + 1
  const seniorClassYear = month >= 6 ? now.getFullYear() + 1 : now.getFullYear()
  const grade = 12 - (gradYear - seniorClassYear)
  return grade >= 1 && grade <= 12 ? `${grade}th` : null
}

// Name + grade year for display and gating, degraded per the ruling:
//   name  → student_profiles.display_name, else students.name
//   grade → student_profiles.current_year, else students.grade, else from class
// Never throws; a null profile is the expected degrade input, not an error.
export function studentDisplay(student, profile) {
  const studentName = profile?.display_name || String(student?.name ?? '').trim()
  const currentYear =
    profile?.current_year || student?.grade || gradeLabelFromClass(student?.class) || null
  return { studentName, currentYear }
}

// Reverse lookup: a student's { name, email, sheetId } from their sheet id.
// Used by the writing routes when an admin (Aaron/Ryan) edits a specific student's
// docs (?student=<sheetId>) — the sheet id carries no email/name by itself.
//
// `sheets` is UNUSED and retained only so app/api/writing/doc + lib/writingAuth keep
// a zero diff (the /write collab editor is fenced, Aaron 2026-08-27). Drop the
// parameter when the writing lane moves.
export async function studentBySheetId(sheets, sheetId) {
  if (!sheetId) return null
  const { data, error } = await getSupabaseClient()
    .from('students')
    .select('name, student_email, status')
    .eq('student_sheet_id', sheetId)
    .eq('status', 'active') // NC excluded
    .limit(1)
  if (error) throw new Error(`studentBySheetId failed: ${error.message}`)
  if (!data || !data.length) return null
  return { name: String(data[0].name ?? '').trim(), email: normEmail(data[0].student_email), sheetId }
}

// ── Roster list (the whole student body) ────────────────────────────────────
// The dev surfaces (Scoring spot-check, Students cards, the Writing picker) need
// EVERY student as { name, grade(=Class cell), classYear, sheetId } — a list, not
// the email→identity lookup resolveIdentity does. Different shape, same data.
// classYear = the 4-digit grad year parsed from the Class cell ("'27" → 2027);
// grade keeps the raw cell for back-compat.
export function classYearFromClass(klass) {
  const m = String(klass ?? '').match(/(\d{2})\s*$/)
  return m ? 2000 + Number(m[1]) : null
}

// The `students` table. student_sheet_id IS the key (PK convention). No status
// filter — this surface never dropped NC rows. NC is stored as status='nc' with an
// empty `class`, but the Sheet's Class cell literally read "NC", so reconstruct
// that label to keep `grade` byte-identical for the dev cards.
//
// No email filter and no status filter is also what makes a PRE-AUTH roster row
// (phase 2b, student_email NULL) visible on every internal surface the moment it
// is created, with no further code. `sheets` is unused; see studentBySheetId.
async function listStudentsFromSupabase() {
  const { data, error } = await getSupabaseClient()
    .from('students')
    .select('student_sheet_id, name, class, status')
  if (error) throw new Error(`listStudents failed: ${error.message}`)
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

export async function listStudents(sheets) {
  return listStudentsFromSupabase()
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
  // Identity is Supabase-only. `sheets` is still BUILT and RETURNED because
  // app/api/parent/colleges destructures it and hands it to fetchCollegeData —
  // college lists are out of B/D/F scope and still read a student sheet. Removing
  // it here would 500 that route while `npm run build` stayed green (destructuring
  // an absent key yields undefined), which is why it is called out rather than
  // quietly dropped. quotaUser: each parent gets their own read-quota bucket.
  const sheets = getGoogleSheetsClient(email)
  const identity = await resolveIdentity(email)
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
