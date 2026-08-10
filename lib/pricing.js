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
export async function getQuote(id, supabase = getSupabaseClient()) {
  try {
    const { data, error } = await supabase
      .from(QUOTES_TABLE)
      .select('id, created_at, created_by, student_name, grade, selection, email_html')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    return data || null
  } catch {
    return null
  }
}

export async function saveQuote({ studentName, grade, selection, emailHtml, createdBy }, supabase = getSupabaseClient()) {
  const { data, error } = await supabase
    .from(QUOTES_TABLE)
    .insert({
      student_name: studentName || null,
      grade: grade || null,
      selection,
      email_html: emailHtml || null,
      created_by: createdBy || null,
    })
    .select('id, created_at, created_by, student_name, grade')
    .single()
  if (error) throw error
  return data
}
