// Server-only: turn an accepted package quote into portal identities.
//
// This is the "bridge the gap between leads and current students" seam (Aaron,
// 2026-08-11): a family that accepts a proposal should become a student+parent
// profile without anyone retyping what the builder already knows. It reuses the
// exact Clerk conventions of scripts/provisionStudentAccounts.cjs /
// provisionParentAccounts.cjs (find-then-create, idempotent, memorable
// passwords, publicMetadata.role student/parent), as a lib the API route can
// call for ONE family instead of a bulk sheet sweep.
//
// SPLIT IN TWO (phase 2b, 2026-09-02 — Aaron 2026-08-31: a student must exist and
// surface INTERNALLY before they have an email, with the invite firing later).
//
//   1. createRosterStudent()  — the roster row, with NO email and NO Clerk. This
//                               is what makes a signed contract visible to staff
//                               on day one.
//   2. provisionFamily()      — the Clerk identities, unchanged. Stamping
//                               students.student_email is what actually opens the
//                               door, and that is one column write.
//
// The two locks that keep a pending student invisible to themselves are both
// passive, which is why this needs no gate of its own: getStudentByEmail rejects a
// blank target before it queries, so a NULL student_email can never match a
// session; and no Clerk user exists to sign in with. Meanwhile
// listStudentsFromSupabase filters on neither email nor status, so the row shows
// up on every internal roster surface the moment it exists.
//
// Key: CLERK_SECRET_KEY_PROD when present (local .env.local carries both keys;
// on Vercel prod the runtime CLERK_SECRET_KEY is already the live key).

import { getSupabaseClient } from './supabase'

const CLERK_API = 'https://api.clerk.com/v1'

// Synthetic primary key for a student who has no Google sheet — and, under the
// zero-Google ruling, never will. Already live: 'portal:diya-sindol', created by
// hand 2026-08-31. Every FK in the schema references students(student_sheet_id) as
// opaque text, so nothing needs a migration to accept it.
//
// ⚠ It is NOT opaque to the two Sheets calls that deliberately remain
// (getUpdateFormData's transcript grid read and submitUpdateForm's grade write):
// passing it as a spreadsheetId would send Google a garbage id. Both now guard on
// this prefix. See isPortalNative().
export const PORTAL_KEY_PREFIX = 'portal:'

export function isPortalNative(studentSheetId) {
  return String(studentSheetId ?? '').startsWith(PORTAL_KEY_PREFIX)
}

const ADJECTIVES = ['amber', 'bold', 'brave', 'bright', 'calm', 'cedar', 'clear', 'clever', 'coral', 'crisp', 'eager', 'ember', 'golden', 'grand', 'hazel', 'indigo', 'jade', 'keen', 'lively', 'lucky', 'maple', 'mighty', 'noble', 'opal', 'pearl', 'proud', 'quiet', 'regal', 'river', 'royal', 'sandy', 'serene', 'silver', 'smart', 'solar', 'stellar', 'sturdy', 'sunny', 'swift', 'teal', 'tidal', 'true', 'vivid', 'warm', 'wise', 'witty']
const NOUNS = ['acorn', 'anchor', 'aspen', 'badger', 'beacon', 'birch', 'bison', 'breeze', 'brook', 'canyon', 'cliff', 'comet', 'compass', 'crane', 'creek', 'delta', 'dolphin', 'eagle', 'falcon', 'forest', 'garden', 'grove', 'harbor', 'hawk', 'heron', 'horizon', 'island', 'lagoon', 'lantern', 'lark', 'lily', 'lotus', 'meadow', 'mesa', 'mountain', 'oasis', 'ocean', 'orchard', 'osprey', 'otter', 'owl', 'pebble', 'pine', 'prairie', 'raven', 'reef', 'ridge', 'robin', 'sage', 'sparrow', 'summit', 'sunrise', 'tiger', 'trail', 'tulip', 'valley', 'vista', 'walnut', 'wave', 'willow', 'wren', 'zephyr']

export function generatePassword() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${String(Math.floor(Math.random() * 90) + 10)}`
}

function clerkKey() {
  const key = process.env.CLERK_SECRET_KEY_PROD || process.env.CLERK_SECRET_KEY
  if (!key) throw new Error('No Clerk secret key configured')
  return key
}

async function clerkFetch(method, pathname, body) {
  const res = await fetch(`${CLERK_API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${clerkKey()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, json }
}

async function findUser(email) {
  const { status, json } = await clerkFetch('GET', `/users?email_address=${encodeURIComponent(email)}&limit=1`)
  if (status !== 200) throw new Error(`Clerk lookup → ${status}`)
  return Array.isArray(json) && json.length ? json[0] : null
}

const pwnedOrInvalid = (json) =>
  JSON.stringify(json || '').match(/form_password_pwned|form_password_length|password/i)

// Idempotently ensure a Clerk user exists for `email` with the given role.
// Returns { email, role, status: 'exists'|'created'|'would-create'|'error', userId?, existingRole?, password?, error? }.
// A password is returned ONLY when the account was created this call — an
// existing account's password is unknown here by design (reset flows own that).
//
// An EXISTING user is never mutated. The first cut patched a missing role onto
// existing accounts, which would have stamped role:'parent' onto Ryan's
// deliberately role-less admin identities the first time one appeared in
// parentEmails (adversarial-review finding, 2026-08-11). Instead the existing
// role (or its absence) is reported, and the caller decides whether that needs
// a human look.
async function ensureUser(email, role, { commit }) {
  const existing = await findUser(email)
  if (existing) {
    return { email, role, status: 'exists', userId: existing.id, existingRole: existing.public_metadata?.role ?? null }
  }
  if (!commit) return { email, role, status: 'would-create' }
  let password = generatePassword()
  let created = await clerkFetch('POST', '/users', {
    email_address: [email],
    password,
    public_metadata: { role },
  })
  if (created.status === 422 && pwnedOrInvalid(created.json)) {
    password = generatePassword()
    created = await clerkFetch('POST', '/users', {
      email_address: [email],
      password,
      public_metadata: { role },
    })
  }
  if (created.status !== 200) {
    return { email, role, status: 'error', error: JSON.stringify(created.json?.errors?.[0]?.message || created.json).slice(0, 200) }
  }
  return { email, role, status: 'created', userId: created.json.id, password }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const slugify = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

// STEP 1 — the roster row, before the student has an email.
//   { name, class?, packageType?, guardianEmails?, commit } → { student, created }
//
// Writes `students` (student_email NULL, status 'active', meetings_source 'portal'
// — a portal-native student has no 📆 sheet tab to mirror), any known guardians,
// and a `student_profiles` row.
//
// ⚠ THE student_profiles ROW IS NOT OPTIONAL, and it is the least obvious part of
// this function. The AP-Counseling omnibar builds its index from student_profiles
// keyed by DISPLAY NAME and never reads `students` at all
// (06. Scripts/omnibar/build_index.py:171,203). Without a profile row, any document
// later pushed for this student mints a SEPARATE synthetic omnibar entry instead of
// attaching to their existing folder-derived row — the student appears twice, once
// with their files and once with everything else.
//
// Idempotent on slug: re-running converges rather than duplicating.
export async function createRosterStudent({
  name,
  class: klass = null,
  packageType = null,
  guardianEmails = [],
  commit = false,
}) {
  const cleanName = String(name || '').trim()
  if (!cleanName) throw new Error('name is required')
  const slug = slugify(cleanName)
  if (!slug) throw new Error(`could not derive a slug from name "${cleanName}"`)
  const studentSheetId = `${PORTAL_KEY_PREFIX}${slug}`

  const guardians = guardianEmails
    .map((e) => String(e || '').trim().toLowerCase())
    .filter(Boolean)
  for (const g of guardians) {
    if (!EMAIL_RE.test(g)) throw new Error(`guardianEmails contains an invalid email: ${g}`)
  }

  const sb = getSupabaseClient()
  const { data: existing, error: exErr } = await sb
    .from('students')
    .select('student_sheet_id, name, slug, student_email, status')
    .eq('student_sheet_id', studentSheetId)
    .maybeSingle()
  if (exErr) throw new Error(`roster lookup failed: ${exErr.message}`)

  const plan = {
    student_sheet_id: studentSheetId,
    slug,
    name: cleanName,
    class: klass,
    package_type: packageType,
    // NOT SET: student_email. That column is the go-live switch (see inviteStudent).
    status: 'active',
    meetings_source: 'portal',
    art_eligible: false,
    updated_at: new Date().toISOString(),
  }

  if (!commit) {
    return {
      student: plan,
      created: !existing,
      guardians,
      dryRun: true,
      note: existing ? 'roster row already exists; commit would converge it' : 'commit:true would create this row',
    }
  }

  const { error: sErr } = await sb.from('students').upsert(plan, { onConflict: 'student_sheet_id' })
  if (sErr) throw new Error(`roster upsert failed: ${sErr.message}`)

  if (guardians.length) {
    const { error: gErr } = await sb.from('guardians').upsert(
      guardians.map((email, i) => ({ student_sheet_id: studentSheetId, email, ordinal: i + 1 })),
      { onConflict: 'student_sheet_id,ordinal' }
    )
    if (gErr) throw new Error(`guardians upsert failed: ${gErr.message}`)
  }

  // See the ⚠ above: the omnibar joins on display_name from THIS table.
  const { error: pErr } = await sb.from('student_profiles').upsert(
    { student_sheet_id: studentSheetId, display_name: cleanName, updated_at: new Date().toISOString() },
    { onConflict: 'student_sheet_id' }
  )
  if (pErr) throw new Error(`student_profiles upsert failed: ${pErr.message}`)

  return { student: plan, created: !existing, guardians, dryRun: false }
}

// STEP 2b — open the door. Stamping student_email is the ONLY thing standing
// between a pending roster row and a student who can sign in, so it is deliberately
// its own named call rather than a field on some larger update.
export async function inviteStudent({ studentSheetId, studentEmail, commit = false }) {
  const email = String(studentEmail || '').trim().toLowerCase()
  if (!EMAIL_RE.test(email)) throw new Error('studentEmail is not a valid email')
  if (!studentSheetId) throw new Error('studentSheetId is required')
  if (!commit) return { studentSheetId, studentEmail: email, dryRun: true }

  const { error } = await getSupabaseClient()
    .from('students')
    .update({ student_email: email, updated_at: new Date().toISOString() })
    .eq('student_sheet_id', studentSheetId)
  if (error) throw new Error(`invite (student_email stamp) failed: ${error.message}`)
  return { studentSheetId, studentEmail: email, dryRun: false }
}

// Provision the identities for one accepted quote.
//   { studentEmail, parentEmails: [..], commit } → { accounts: [...], manualSteps: [...] }
// Dry-run (commit falsy) reports what would happen and writes nothing.
export async function provisionFamily({ studentEmail, parentEmails = [], commit = false }) {
  const student = String(studentEmail || '').trim().toLowerCase()
  const parents = parentEmails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean)
  if (!EMAIL_RE.test(student)) throw new Error('studentEmail is not a valid email')
  for (const p of parents) if (!EMAIL_RE.test(p)) throw new Error(`parentEmails contains an invalid email: ${p}`)
  if (parents.includes(student)) throw new Error('studentEmail also appears in parentEmails')

  // Each account is attempted independently and a failure is RECORDED, never
  // thrown: a thrown parent lookup after a successful student creation would
  // discard the response carrying the only copy of that student's password
  // (adversarial-review finding, 2026-08-11 — the .cjs scripts' per-row
  // error-capture posture, kept here).
  const attempt = async (email, role) => {
    try {
      return await ensureUser(email, role, { commit })
    } catch (err) {
      return { email, role, status: 'error', error: String(err.message || err).slice(0, 200) }
    }
  }
  const accounts = []
  accounts.push(await attempt(student, 'student'))
  for (const p of parents) accounts.push(await attempt(p, 'parent'))

  return {
    accounts,
    // True only when every account is usable (created now or already there) —
    // the condition the route requires before stamping a provision receipt.
    allOk: accounts.every((a) => a.status === 'created' || a.status === 'exists' || a.status === 'would-create'),
    // The rest of onboarding this seam does NOT do yet — named so a green
    // response can't read as "the family is fully onboarded".
    // Updated 2026-09-02: the Master Sheet is no longer the roster of record, so
    // "add a row to 👩‍🎓 All Data" and "create the student sheet from the template"
    // are gone. createRosterStudent() does the roster half; inviteStudent() stamps
    // the email. What is left is genuinely human.
    manualSteps: [
      'If no roster row exists yet, run createRosterStudent({ name, class, packageType, guardianEmails, commit: true })',
      'Stamp the email onto that row with inviteStudent({ studentSheetId, studentEmail, commit: true }) — this is what lets them sign in',
      'Deliver the portal password to the family (it appears only in this response)',
      'Seed committed deliverables (competitions, projects) into Comps & Projects from the contract payload',
    ],
  }
}
