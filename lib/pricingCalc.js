// Pure package-quote calculator — the in-app replacement for the auto-generator
// sheet's Menu cost columns (P/Q/R) and the Backend discount/bonus helpers.
// Client-safe: no server imports. Luxon (America/Los_Angeles) for every date
// decision so seasonal windows never drift on Vercel's UTC clock.
//
// computeQuote(state, config, refISO?) returns per-package numbers + line items
// that lib/packageEmail.js renders into the proposal email. Faithful to the
// live sheet's arithmetic (verified 2026-06-15):
//   subtotal P19 = base + Σ add-ons
//   late-start P18 = seasonal discount (off-season only)
//   per-add-on disc P17 = (2% × #selected categories) × (subtotal − late-start)
//   referral/sibling/custom = 5%/5%/custom × (subtotal − late-start)
//   total P21 = subtotal − perAddOn − lateStart − referral − sibling − custom
//   early-start bonus = weeks-to-Sept-1 × rate × tier multiplier (in-window only)

import { DateTime } from 'luxon'
import { GRADES, PACKAGES, ADDON_DEFS } from './pricingSchema'

const ZONE = 'America/Los_Angeles'

function now(refISO) {
  const dt = refISO ? DateTime.fromISO(refISO, { zone: ZONE }) : DateTime.now().setZone(ZONE)
  return dt.isValid ? dt : DateTime.now().setZone(ZONE)
}

// Per-package cost of a single add-on given a selection value.
function addOnAmount(key, value, pkg, config) {
  const def = ADDON_DEFS.find((d) => d.key === key)
  if (!def) return 0
  if (def.kind === 'perPackageCount') {
    const n = Number(value) || 0
    return n * (config.addOns.extraCollege?.[pkg] || 0)
  }
  if (def.kind === 'count') {
    const n = Number(value) || 0
    return n * (config.addOns[key] || 0)
  }
  // flat (checkbox)
  return value ? config.addOns[key] || 0 : 0
}

// A selection is "active" when a count ≥ 1 or a checkbox is true.
function isActive(key, value) {
  const def = ADDON_DEFS.find((d) => d.key === key)
  if (!def) return false
  if (def.kind === 'flat') return !!value
  return (Number(value) || 0) >= 1
}

// Human-readable count suffix, matching the sheet ("Extra Colleges (5)",
// "Internship & Research (1)"); flat items show no count.
function lineLabel(def, value) {
  if (def.kind === 'flat') return def.label
  const n = Number(value) || 0
  if (def.key === 'extraCollege') return `${n === 1 ? 'Extra College' : 'Extra Colleges'} (${n})`
  return `${def.label} (${n})`
}

function buildLines(selection, pkg, config) {
  const lines = []
  for (const def of ADDON_DEFS) {
    const value = selection?.[def.key]
    if (!isActive(def.key, value)) continue
    const amount = addOnAmount(def.key, value, pkg, config)
    lines.push({ key: def.key, label: lineLabel(def, value), count: def.kind === 'flat' ? null : Number(value) || 0, amount })
  }
  return lines
}

// Resolve the late-start discount for a package at the reference month.
function lateStartFor(pkg, config, dt) {
  const m = dt.month
  const win = (config.lateStart || []).find((w) => {
    if (w.startMonth <= w.endMonth) return m >= w.startMonth && m <= w.endMonth
    return m >= w.startMonth || m <= w.endMonth // wrap-around window
  })
  return win ? Number(win[pkg]) || 0 : 0
}

// Early-start: weeks from start date to the target (Sept 1) and whether today is
// inside the apply window.
function earlyStartContext(config, dt) {
  const e = config.earlyStart
  const year = dt.year
  const applyStart = DateTime.fromObject({ year, month: e.applyStartMonth, day: e.applyStartDay }, { zone: ZONE }).startOf('day')
  const applyEnd = DateTime.fromObject({ year, month: e.applyEndMonth, day: e.applyEndDay }, { zone: ZONE }).endOf('day')
  const applies = dt >= applyStart && dt <= applyEnd
  let target = DateTime.fromObject({ year, month: e.targetMonth, day: e.targetDay }, { zone: ZONE }).startOf('day')
  if (target < dt.startOf('day')) target = target.plus({ years: 1 })
  const weeks = Math.max(0, target.diff(dt.startOf('day'), 'days').days / 7)
  return { applies, weeks }
}

const round = (n) => Math.round(n)

export function computeQuote(state, config, refISO) {
  const dt = now(refISO)
  const grade = String(state?.grade || '')
  const gradeOk = GRADES.includes(grade)
  const disc = state?.discounts || {}
  const custom = Math.max(0, Number(disc.custom) || 0) // fraction, e.g. 0.1
  const { applies: earlyApplies, weeks } = earlyStartContext(config, dt)

  const packages = {}
  for (const pkg of PACKAGES) {
    const services = state?.services?.[pkg] || {}
    const bonusSel = state?.bonuses?.[pkg] || {}

    const base = gradeOk ? Number(config.base[grade][pkg]) || 0 : 0
    const serviceLines = buildLines(services, pkg, config)
    const addOnTotal = serviceLines.reduce((s, l) => s + l.amount, 0)
    const subtotal = base + addOnTotal

    const lateStart = lateStartFor(pkg, config, dt)
    const afterLS = subtotal - lateStart

    const categories = ADDON_DEFS.filter((d) => isActive(d.key, services?.[d.key])).length
    const perAddOnDiscount = (categories * (config.discounts.perAddOnPct / 100)) * afterLS
    const referralDiscount = disc.referral ? (config.discounts.referralPct / 100) * afterLS : 0
    const siblingDiscount = disc.sibling ? (config.discounts.siblingPct / 100) * afterLS : 0
    const customDiscount = custom > 0 ? custom * afterLS : 0

    // Discount is computed from the UNROUNDED total, then rounded — the sheet
    // does TEXT(P19-P21,"#,##0") on the raw figures (e.g. $4,462.5 → $4,463),
    // which differs from rounding the total first.
    const totalRaw = subtotal - perAddOnDiscount - lateStart - referralDiscount - siblingDiscount - customDiscount
    const totalDiscountRaw = subtotal - totalRaw
    const totalDiscountPct = subtotal > 0 ? round((totalDiscountRaw / subtotal) * 100) : 0

    // Bonuses (sign-on perks) reuse the same add-on prices, plus early start.
    const bonusLines = buildLines(bonusSel, pkg, config)
    const earlyStartValue = earlyApplies
      ? weeks * config.discounts.earlyStartRate * (config.earlyStart.multiplier[pkg] || 0)
      : 0
    const bonusTotal = bonusLines.reduce((s, l) => s + l.amount, 0) + earlyStartValue

    const otherDiscountsCount =
      (disc.referral ? 1 : 0) + (disc.sibling ? 1 : 0) + (custom > 0 ? 1 : 0) + (lateStart > 0 ? 1 : 0)

    packages[pkg] = {
      base,
      serviceLines,
      addOnTotal,
      subtotal,
      lateStart,
      afterLS,
      categories,
      perAddOnDiscount: round(perAddOnDiscount),
      referralDiscount: round(referralDiscount),
      siblingDiscount: round(siblingDiscount),
      customDiscount: round(customDiscount),
      total: round(totalRaw),
      totalDiscount: round(totalDiscountRaw),
      totalDiscountPct,
      eligibleAddOnCount: serviceLines.length,
      otherDiscountsCount,
      bonusLines,
      earlyStartValue: round(earlyStartValue),
      bonusTotal: round(bonusTotal),
    }
  }

  return {
    grade,
    gradeOk,
    earlyStartApplies: earlyApplies,
    weeks: Math.round(weeks * 10) / 10,
    referralPct: config.discounts.referralPct,
    siblingPct: config.discounts.siblingPct,
    customPct: round(custom * 100),
    earlyStartRate: config.discounts.earlyStartRate,
    packages,
  }
}

// $#,##0 — matches the sheet's TEXT(x,"#,##0").
export function money(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('en-US')
}
