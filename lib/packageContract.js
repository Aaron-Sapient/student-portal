// A saved package quote, read as a CONTRACT rather than a price.
//
// The reframe this implements (Aaron, 2026-08-11 session): picking "5
// Competitions" on a tier commits AP to five competition deliverables — the
// same data that is the proposal PDF's most persuasive content is also the
// payload the student portal needs to onboard the family without being told
// everything again by hand. So this module turns a saved quote's builder
// selection into a structured, per-tier list of committed deliverables.
//
// Client-safe and pure (no Supabase, no env): it leans on computeQuote for
// every dollar figure so a contract can never disagree with the proposal about
// money, and on ADDON_DEFS so a new add-on is quantified the day it exists.
//
// What this deliberately does NOT invent: booking cadence and timeline
// templates per tier. Those are business commitments Ryan/Aaron haven't
// encoded anywhere yet; when they exist they belong in pricing config (like
// paymentTerms), not hardcoded here. The contract carries the slot empty.

import { ADDON_DEFS, PACKAGE_LABELS, normalizeSelectedPackages, mergeConfig } from './pricingSchema'
import { computeQuote } from './pricingCalc'
import { PACKAGE_INCLUDED } from './packageContent'

// How each add-on quantifies as a committed deliverable. Flat add-ons whose
// label carries their own quantity (5/10 competitions, 5/10 tutoring hours)
// decode to that quantity; counted add-ons commit their count.
const QUANTIFY = {
  extraCollege: (n) => ({ unit: 'extra colleges', qty: n }),
  competitions5: () => ({ unit: 'competitions', qty: 5 }),
  competitions10: () => ({ unit: 'competitions', qty: 10 }),
  internship: (n) => ({ unit: 'internship & research tracks', qty: n }),
  soloProject: (n) => ({ unit: 'solo passion projects', qty: n }),
  groupProject: (n) => ({ unit: 'group projects', qty: n }),
  groupSat: (n) => ({ unit: 'group SAT courses', qty: n }),
  satPopular: () => ({ unit: 'SAT Popular Combo', qty: 1 }),
  satPremium: () => ({ unit: 'SAT Premium Combo', qty: 1 }),
  seniorAp5: () => ({ unit: 'senior AP tutoring hours', qty: 5 }),
  seniorAp10: () => ({ unit: 'senior AP tutoring hours', qty: 10 }),
  juniorAp5: () => ({ unit: 'junior AP tutoring hours', qty: 5 }),
  juniorAp10: () => ({ unit: 'junior AP tutoring hours', qty: 10 }),
}

function deliverablesFrom(lines, { bonus }) {
  return lines.map((l) => {
    const q = QUANTIFY[l.key] ? QUANTIFY[l.key](l.count ?? 0) : { unit: l.label, qty: l.count ?? 1 }
    return { key: l.key, label: l.label, unit: q.unit, qty: q.qty, value: l.amount, bonus }
  })
}

// quoteRow: a package_quotes row ({ id, created_at, student_name, grade,
// selection, config_snapshot, lead_id }). config: the merged pricing config
// (readPricing()) — used ONLY when the row predates config_snapshot.
//
// Dollar figures are re-derived from the row's own config_snapshot (frozen at
// save time) with the CONTENT's own date as the reference, so both the price
// inputs and the seasonal parts (late-start window, early-start bonus)
// reproduce the numbers the family actually saw — a contract must not move
// when the pricing dashboard does (adversarial-review finding, 2026-08-11).
//
// That reference is `updated_at ?? created_at`, NOT created_at. A proposal is
// editable in place, and an update rewrites selection, email_html and
// config_snapshot while created_at deliberately stays the first save. Pricing
// August content at a June reference date resurrects a season that had closed:
// an early-start bonus and a late-start discount reappear in the contract that
// appear nowhere in the email the family holds, and provisioning stamps that
// into an immutable receipt (adversarial-review finding, same day).
//
// A legacy row with no snapshot re-derives against the caller's current
// config, and `configSource` says which happened so a consumer can tell a
// frozen figure from a best-effort one. email_html stays the faithful record
// of the sent ARTIFACT; this is the faithful record of the COMMITMENT.
export function buildContract(quoteRow, config) {
  const selection = quoteRow?.selection || {}
  const snap = quoteRow?.config_snapshot
  const effectiveConfig = snap ? mergeConfig(snap) : config
  const contentAt = quoteRow?.updated_at || quoteRow?.created_at
  const quote = computeQuote(selection, effectiveConfig, contentAt)
  const offered = normalizeSelectedPackages(selection.selectedPackages)

  const tiers = {}
  for (const pkg of offered) {
    const P = quote.packages[pkg]
    const bonusLines = P.bonusLines || []
    const bonuses = deliverablesFrom(bonusLines, { bonus: true })
    if (quote.earlyStartApplies && P.earlyStartValue > 0) {
      bonuses.push({
        key: 'earlyStart',
        label: `Early Start Bonus (${quote.weeks} weeks)`,
        unit: 'weeks of early-start advising',
        qty: quote.weeks,
        value: P.earlyStartValue,
        bonus: true,
      })
    }
    tiers[pkg] = {
      label: PACKAGE_LABELS[pkg],
      total: P.total,
      base: P.base,
      includedSummary: PACKAGE_INCLUDED[pkg] || '',
      deliverables: deliverablesFrom(P.serviceLines || [], { bonus: false }),
      bonuses,
      // Slot for per-tier cadence/timeline commitments once they're config
      // (see module note) — null means "not yet encoded", never "none".
      cadence: null,
    }
  }

  return {
    quoteId: quoteRow?.id ?? null,
    // The date these figures describe (the reference they were priced at),
    // which after an in-place edit is the edit's date, not the first save's.
    quotedAt: contentAt ?? null,
    firstSavedAt: quoteRow?.created_at ?? null,
    leadId: quoteRow?.lead_id ?? null,
    configSource: snap ? 'snapshot' : 'current',
    student: {
      name: quoteRow?.student_name || `${selection.firstName || ''} ${selection.lastName || ''}`.trim(),
      firstName: selection.firstName || '',
      lastName: selection.lastName || '',
      grade: String(quoteRow?.grade || selection.grade || ''),
      gender: selection.gender || null,
    },
    offered,
    tiers,
  }
}
