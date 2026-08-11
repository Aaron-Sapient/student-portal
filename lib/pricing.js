// Server-only package-pricing store. The no-code "pricing dashboard" persists
// here: one JSONB row in Supabase (project: student-hubs), table
// `pricing_config`, id=1 — mirrors lib/scoreParams.js's read/validate/write
// shape but Supabase-backed. Pricing is non-secret (emailed to prospects, shown
// on the public checkout), so the student-visible project is fine and a public
// read can be exposed later for the parent-facing /packages fold (Task 2).
//
// Schema/defaults/validation live in lib/pricingSchema.js (client-safe). Keep
// the Supabase import out of that module so the dashboard + calculator stay
// browser-importable.

import { getSupabaseClient } from './supabase'
import { DEFAULT_PRICING, mergeConfig, studentNameKey } from './pricingSchema'

export const PRICING_TABLE = 'pricing_config'
export const PRICING_ROW_ID = 1
export const QUOTES_TABLE = 'package_quotes'

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)))

// Read the active config (defaults merged with the stored row). A missing table
// or row → pure defaults, so the generator works before the dashboard is saved.
export async function readPricing(supabase = getSupabaseClient()) {
  try {
    const { data, error } = await supabase
      .from(PRICING_TABLE)
      .select('config')
      .eq('id', PRICING_ROW_ID)
      .maybeSingle()
    if (error) throw error
    return mergeConfig(data?.config)
  } catch {
    return clone(DEFAULT_PRICING)
  }
}

// Upsert the single active config row. Caller must validatePricing first.
export async function writePricing(config, updatedBy, supabase = getSupabaseClient()) {
  const { error } = await supabase.from(PRICING_TABLE).upsert(
    {
      id: PRICING_ROW_ID,
      config,
      updated_by: updatedBy || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  )
  if (error) throw error
}

// --- Saved quotes ("save student profile" in the sheet) ---

// Newest-first list. A missing table → empty list (so the tab renders before
// the migration runs). updated_at is requested separately from the rest because
// it is the newest column: on an environment where the migration has not run,
// asking for it would fail the WHOLE list rather than one field, which is the
// config_snapshot lesson (see getQuote) applied to a select list.
const LIST_COLS = 'id, created_at, created_by, student_name, grade'
export async function listQuotes(supabase = getSupabaseClient()) {
  const run = (cols) =>
    supabase.from(QUOTES_TABLE).select(cols).order('created_at', { ascending: false }).limit(200)
  try {
    const withUpdated = await run(`${LIST_COLS}, updated_at`)
    if (!withUpdated.error) return withUpdated.data || []
    if (!/updated_at/.test(String(withUpdated.error.message || ''))) throw withUpdated.error
    console.error('listQuotes: updated_at column missing — run scripts/supabase-pricing-schema.sql')
    const { data, error } = await run(LIST_COLS)
    if (error) throw error
    return data || []
  } catch {
    return []
  }
}

// The name-matching key is defined in the client-safe schema module so the
// builder and the server agree on what "the same student" means.
export { studentNameKey }

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

// Every saved proposal for this student name, newest first. Drives the
// builder's "update <name>'s proposal, or is this a new student?" prompt.
//
// Matching happens here rather than in the browser because the client's list
// can be minutes stale, and the whole point is to catch a row that already
// exists — including one another admin saved thirty seconds ago.
//
// A TARGETED query, not a scan of listQuotes: that capped at the 200 newest
// rows, so past row 200 the oldest students — the long-standing families most
// likely to be re-quoted — would silently stop matching and the duplicate this
// exists to prevent would come back with no signal at all. The `%` pattern is
// a deliberately loose prefilter ("Ann%Lee" also fetches "Ann Marie Lee");
// exactness comes from the studentNameKey comparison below, so looseness costs
// a row or two of I/O and can never produce a false match.
//
// Errors THROW rather than degrading to "no duplicate found". Failing open
// here means a blind insert, and the transient conditions that cause it are
// exactly the ones during which an admin retries a save — a
// duplicate-manufacturing machine. A failed check must fail the save.
export async function findQuotesByStudentName(studentName, supabase = getSupabaseClient()) {
  const key = studentNameKey(studentName)
  if (!key) return []
  const pattern = key.split(' ').map(escapeLike).join('%')
  const { data, error } = await supabase
    .from(QUOTES_TABLE)
    .select(`${LIST_COLS}, updated_at, provisioned_at`)
    .ilike('student_name', pattern)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []).filter((r) => studentNameKey(r.student_name) === key)
}

// Overwrite a saved proposal in place. Only the proposal CONTENT moves:
// created_at/created_by stay the first save, and lead_id/provision are left
// alone so provenance and any acceptance receipt survive an edit.
//
// A provisioned quote is refused. Once a proposal has become a student it is
// the record of what that family accepted, and rewriting it would destroy the
// accepted terms with no trace — markQuoteProvisioned goes to real trouble to
// chain receipts rather than drop them, and this must not undo that. The
// caller is expected to offer "save as new" instead.
// How many superseded versions to keep. Each carries a full email_html
// (~20KB), so this is a deliberate bound rather than unlimited history.
const PREVIOUS_LIMIT = 5

export async function updateQuote(id, { studentName, grade, selection, emailHtml, config, updatedBy }, supabase = getSupabaseClient()) {
  const { data: current, error: readErr } = await supabase
    .from(QUOTES_TABLE)
    .select('id, provisioned_at, created_at, updated_at, selection, email_html, config_snapshot, previous')
    .eq('id', id)
    .maybeSingle()
  if (readErr) throw readErr
  if (!current) throw new Error('Quote not found')
  if (current.provisioned_at) throw provisionedError()

  // Chain the outgoing content instead of destroying it. email_html is the
  // only faithful record of what a family was actually sent, and a proposal is
  // most often reopened precisely because a family is negotiating against the
  // version already in their inbox.
  const superseded = {
    at: current.updated_at || current.created_at,
    selection: current.selection,
    email_html: current.email_html,
    config_snapshot: current.config_snapshot,
  }
  const previous = [superseded, ...(Array.isArray(current.previous) ? current.previous : [])].slice(0, PREVIOUS_LIMIT)

  const row = {
    student_name: studentName || null,
    grade: grade || null,
    selection,
    email_html: emailHtml || null,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy || null,
    previous,
  }
  if (config) row.config_snapshot = config

  // `.is('provisioned_at', null)` makes the refusal ATOMIC rather than a
  // read-then-write. Without it, Ryan clicking Provision between the read
  // above and this write would leave a receipt describing a tier that the
  // freshly-overwritten selection no longer produces — the exact record this
  // guard exists to protect, defeated by ordinary two-admin timing.
  const { data, error } = await supabase
    .from(QUOTES_TABLE)
    .update(row)
    .eq('id', id)
    .is('provisioned_at', null)
    .select(`${LIST_COLS}, updated_at, updated_by`)
  if (error) throw error
  if (!data || !data.length) throw provisionedError()
  return data[0]
}

function provisionedError() {
  const err = new Error(
    'That proposal has already been provisioned into a student, so it cannot be overwritten. Save this as a new proposal instead.'
  )
  err.code = 'PROVISIONED'
  return err
}

// One saved quote, with the two fields listQuotes omits: `selection` (the whole
// builder state at save time) and `email_html` (what was actually sent).
//
// Both are needed, for different jobs. `email_html` is the only faithful record
// of the sent proposal. `selection` can be re-rendered — but NOT identically,
// because buildEmail resolves the season, the late-start window and the whole
// early-start block against a reference date. Re-render a July quote in October
// and the bonus renames, a late-start discount appears, the early-start block
// vanishes and every total moves. A caller that wants the original must pass
// `created_at` as buildEmail's refISO; a caller that wants a refreshed offer
// deliberately does not. That choice belongs to whoever wires up reopening.
//
// Missing table or row → null, matching listQuotes/readPricing so an
// unprovisioned table degrades instead of surfacing a Postgres error.
// select('*') on purpose: the column set has grown twice (2026-08-11 added
// lead_id/provision/provisioned_at, then config_snapshot) and a hardcoded list
// makes every un-migrated environment read as "quote not found" — a maximally
// confusing signature (adversarial-review finding, same day). The catch logs
// before degrading to null so a real Postgres error is at least visible.
export async function getQuote(id, supabase = getSupabaseClient()) {
  try {
    const { data, error } = await supabase
      .from(QUOTES_TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    return data || null
  } catch (err) {
    console.error('getQuote degraded to null:', err?.message || err)
    return null
  }
}

// leadId: accepted only as a positive-integer string/number. The looser
// Number() coercion took `true` to lead_id=1 — a concrete false provenance
// link to a real lead (adversarial-review finding, 2026-08-11).
function normalizeLeadId(leadId) {
  if (typeof leadId !== 'number' && typeof leadId !== 'string') return null
  const s = String(leadId).trim()
  return /^[1-9]\d*$/.test(s) ? Number(s) : null
}

export async function saveQuote({ studentName, grade, selection, emailHtml, createdBy, leadId, config }, supabase = getSupabaseClient()) {
  const row = {
    student_name: studentName || null,
    grade: grade || null,
    selection,
    email_html: emailHtml || null,
    created_by: createdBy || null,
    // Provenance link to the scoreapp_leads row this proposal answers (an
    // AP-project id, so a plain bigint — cross-project FKs don't exist).
    // Absent = manual referral, a normal signature rather than a defect.
    lead_id: normalizeLeadId(leadId),
  }
  // Freeze the pricing config the proposal was built against, so the contract
  // (lib/packageContract.js) re-derives the numbers the family actually saw
  // even after the pricing dashboard moves. Tolerate the column not existing
  // yet — the migration (scripts/supabase-pricing-schema.sql) is additive and
  // may lag a deploy — but say so loudly, because every quote saved without a
  // snapshot is permanently exposed to config drift.
  const cols = 'id, created_at, created_by, student_name, grade, lead_id'
  if (config) {
    const withSnap = await supabase.from(QUOTES_TABLE).insert({ ...row, config_snapshot: config }).select(cols).single()
    if (!withSnap.error) return withSnap.data
    const msg = String(withSnap.error.message || '')
    if (!/config_snapshot/.test(msg)) throw withSnap.error
    console.error('saveQuote: config_snapshot column missing — quote saved WITHOUT a pricing snapshot; run scripts/supabase-pricing-schema.sql')
  }
  const { data, error } = await supabase.from(QUOTES_TABLE).insert(row).select(cols).single()
  if (error) throw error
  return data
}

// Stamp a provisioning receipt onto a quote (the moment a proposal became a
// student). Re-provisioning is legitimate (a typo'd email fixed, a rerun), so
// this is last-write-wins — but the prior receipt is chained under
// `previous` rather than destroyed, so "what did they accept first" survives
// a tier change (adversarial-review finding, 2026-08-11).
export async function markQuoteProvisioned(id, receipt, supabase = getSupabaseClient()) {
  const { data: current } = await supabase
    .from(QUOTES_TABLE)
    .select('provision')
    .eq('id', id)
    .maybeSingle()
  const stamped = current?.provision
    ? { ...receipt, previous: [current.provision, ...(current.provision.previous || [])].map(({ previous, ...r }) => r) }
    : receipt
  const { error } = await supabase
    .from(QUOTES_TABLE)
    .update({ provision: stamped, provisioned_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}
