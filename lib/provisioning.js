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
// Scope honesty — what a commit here does and does not do. It DOES create the
// Clerk identities and return the credential + contract payload. It does NOT
// write the Master Sheet row, create the student sheet, or seed guardians —
// those stay on the existing onboarding checklist (the response names them),
// because this seam should not half-own roster creation until that whole path
// is one machine. Portal sign-in without a Master Sheet row resolves to no
// student, so an early-provisioned account is inert rather than broken.
//
// Key: CLERK_SECRET_KEY_PROD when present (local .env.local carries both keys;
// on Vercel prod the runtime CLERK_SECRET_KEY is already the live key).

const CLERK_API = 'https://api.clerk.com/v1'

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
    manualSteps: [
      'Add the student to the Master Sheet 👩‍🎓 All Data (name, class, col J student email, cols K/L parent emails)',
      'Store the portal password in Master col AW (or run scripts/provisionStudentAccounts.cjs --email … to converge)',
      'Create the student sheet from the template',
      'Seed committed deliverables (competitions, projects) into Comps & Projects from the contract payload',
    ],
  }
}
