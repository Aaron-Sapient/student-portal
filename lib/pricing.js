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
import { DEFAULT_PRICING, mergeConfig } from './pricingSchema'

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
// the migration runs).
export async function listQuotes(supabase = getSupabaseClient()) {
  try {
    const { data, error } = await supabase
      .from(QUOTES_TABLE)
      .select('id, created_at, created_by, student_name, grade')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    return data || []
  } catch {
    return []
  }
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
