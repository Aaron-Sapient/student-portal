// Client-safe package-pricing schema: defaults, constants, merge + validation.
// No server imports here (no Supabase) so the dashboard UI and the pure
// calculator (lib/pricingCalc.js) can both import it in the browser. The
// server-only store (read/write to Supabase) lives in lib/pricing.js.
//
// Verified against the live auto-generator sheet (10quV4-…) on 2026-06-15:
//   base prices = Menu!P3/Q3/R3 · add-ons = Menu!P4:R16 · per-add-on disc =
//   Menu!P17 (2%/category) · referral/sibling = 5% · late-start = Menu!P18 ·
//   early-start bonus = Menu!D22:D26.

export const GRADES = ['9', '10', '11']
export const PACKAGES = ['essential', 'comprehensive', 'vip']
export const PACKAGE_LABELS = {
  essential: 'Essential',
  comprehensive: 'Comprehensive',
  vip: 'VIP',
}

// Add-on catalog — order + labels Ryan sees, plus how each is priced.
//   perPackageCount = a count whose unit price differs per package (extra colleges)
//   count           = a per-unit price × count, same across packages
//   flat            = a checkbox; true → the flat price
export const ADDON_DEFS = [
  { key: 'extraCollege', label: 'Extra Colleges', kind: 'perPackageCount' },
  { key: 'competitions5', label: '5 Competitions', kind: 'flat' },
  { key: 'competitions10', label: '10 Competitions', kind: 'flat' },
  { key: 'internship', label: 'Internship & Research', kind: 'count' },
  { key: 'soloProject', label: 'Solo Passion Project', kind: 'count' },
  { key: 'groupProject', label: 'Group Project', kind: 'count' },
  { key: 'groupSat', label: 'Group SAT', kind: 'count' },
  { key: 'satPopular', label: 'SAT Popular Combo', kind: 'flat' },
  { key: 'satPremium', label: 'SAT Premium Combo', kind: 'flat' },
  { key: 'seniorAp5', label: 'Sr. AP Tutor (5 hrs)', kind: 'flat' },
  { key: 'seniorAp10', label: 'Sr. AP Tutor (10 hrs)', kind: 'flat' },
  { key: 'juniorAp5', label: 'Jr. AP Tutor (5 hrs)', kind: 'flat' },
  { key: 'juniorAp10', label: 'Jr. AP Tutor (10 hrs)', kind: 'flat' },
]

export const DEFAULT_PRICING = {
  base: {
    9: { essential: 8500, comprehensive: 12500, vip: 19500 },
    10: { essential: 7000, comprehensive: 10500, vip: 16500 },
    11: { essential: 5500, comprehensive: 8500, vip: 13500 },
  },
  addOns: {
    extraCollege: { essential: 500, comprehensive: 750, vip: 1000 }, // per school
    competitions5: 7500,
    competitions10: 10000,
    internship: 2500,
    soloProject: 10000,
    groupProject: 5000,
    groupSat: 2500,
    satPopular: 5460,
    satPremium: 6425,
    seniorAp5: 1225,
    seniorAp10: 1950,
    juniorAp5: 725,
    juniorAp10: 950,
  },
  discounts: {
    perAddOnPct: 2, // % off (of subtotal-after-late-start) per selected add-on category
    referralPct: 5,
    siblingPct: 5,
    earlyStartRate: 500, // $/hr a-la-carte rate behind the early-start bonus value
  },
  // "Late-Start Discount" (Menu!P18) — discount applied in off-season windows,
  // $ per package. Matched by current month against [startMonth..endMonth].
  lateStart: [
    { label: 'Fall (Oct–Dec)', startMonth: 10, endMonth: 12, essential: 750, comprehensive: 1000, vip: 1500 },
    { label: 'Winter (Jan–Mar)', startMonth: 1, endMonth: 3, essential: 1500, comprehensive: 2000, vip: 3000 },
    { label: 'Spring/Summer (Apr–Sep)', startMonth: 4, endMonth: 9, essential: 0, comprehensive: 0, vip: 0 },
  ],
  // "Early Start Bonus" (Menu!D22:D26) — when today is inside the apply window,
  // weeks until (targetMonth/targetDay) × earlyStartRate × tier multiplier
  // become a bonus value added to that package's bonus list.
  earlyStart: {
    applyStartMonth: 4,
    applyStartDay: 1,
    applyEndMonth: 8,
    applyEndDay: 31,
    targetMonth: 9,
    targetDay: 1,
    multiplier: { essential: 0.25, comprehensive: 0.5, vip: 1 },
  },
}

// Schema groups that drive the dashboard UI.
export const PRICING_GROUPS = [
  { key: 'base', label: 'Base package price (per grade)', kind: 'baseGrid', hint: 'Starting price for each package at each grade.' },
  { key: 'addOns', label: 'Add-on service prices', kind: 'addOns', hint: 'À-la-carte costs. Extra Colleges is per school and differs by package.' },
  { key: 'discounts', label: 'Discount rates', kind: 'discounts', hint: 'Automatic per-add-on discount and the referral / sibling rates.' },
  { key: 'lateStart', label: 'Late-start discount (seasonal)', kind: 'lateStart', hint: 'Discount applied during off-season months, per package.' },
  { key: 'earlyStart', label: 'Early-start bonus window', kind: 'earlyStart', hint: 'Weeks of free service before the Sept start become a bonus in this window.' },
]

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isMoney = (v) => isNum(v) && v >= 0
const isMonth = (v) => Number.isInteger(v) && v >= 1 && v <= 12
const isDay = (v) => Number.isInteger(v) && v >= 1 && v <= 31

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)))

// Deep-merge a stored partial config over defaults so a missing/added field
// always resolves to a sane value.
export function mergeConfig(stored) {
  const d = DEFAULT_PRICING
  if (!stored || typeof stored !== 'object') return clone(d)
  return {
    base: {
      9: { ...d.base[9], ...stored.base?.[9] },
      10: { ...d.base[10], ...stored.base?.[10] },
      11: { ...d.base[11], ...stored.base?.[11] },
    },
    addOns: {
      ...d.addOns,
      ...stored.addOns,
      extraCollege: { ...d.addOns.extraCollege, ...stored.addOns?.extraCollege },
    },
    discounts: { ...d.discounts, ...stored.discounts },
    lateStart:
      Array.isArray(stored.lateStart) && stored.lateStart.length ? stored.lateStart : clone(d.lateStart),
    earlyStart: {
      ...d.earlyStart,
      ...stored.earlyStart,
      multiplier: { ...d.earlyStart.multiplier, ...stored.earlyStart?.multiplier },
    },
  }
}

// Validate a full candidate config. Returns an error string or null.
export function validatePricing(c) {
  if (!c || typeof c !== 'object') return 'Pricing config missing'
  for (const g of GRADES) {
    for (const p of PACKAGES) {
      if (!isMoney(c.base?.[g]?.[p])) return `Base price for grade ${g} ${PACKAGE_LABELS[p]} must be a number ≥ 0`
    }
  }
  for (const p of PACKAGES) {
    if (!isMoney(c.addOns?.extraCollege?.[p])) return `Extra-college price (${PACKAGE_LABELS[p]}) must be a number ≥ 0`
  }
  for (const def of ADDON_DEFS) {
    if (def.kind === 'perPackageCount') continue
    if (!isMoney(c.addOns?.[def.key])) return `${def.label} price must be a number ≥ 0`
  }
  const d = c.discounts || {}
  for (const [k, lbl] of [
    ['perAddOnPct', 'Per-add-on discount'],
    ['referralPct', 'Referral discount'],
    ['siblingPct', 'Sibling discount'],
  ]) {
    if (!isNum(d[k]) || d[k] < 0 || d[k] > 100) return `${lbl} must be a percent between 0 and 100`
  }
  if (!isMoney(d.earlyStartRate)) return 'Early-start hourly rate must be a number ≥ 0'
  if (!Array.isArray(c.lateStart) || !c.lateStart.length) return 'Late-start windows missing'
  for (const w of c.lateStart) {
    if (!isMonth(w.startMonth) || !isMonth(w.endMonth)) return `Late-start window "${w.label || '?'}" has an invalid month`
    for (const p of PACKAGES) if (!isMoney(w[p])) return `Late-start "${w.label || '?'}" ${PACKAGE_LABELS[p]} must be a number ≥ 0`
  }
  const e = c.earlyStart || {}
  if (!isMonth(e.applyStartMonth) || !isDay(e.applyStartDay) || !isMonth(e.applyEndMonth) || !isDay(e.applyEndDay)) {
    return 'Early-start apply window has an invalid month/day'
  }
  if (!isMonth(e.targetMonth) || !isDay(e.targetDay)) return 'Early-start target date is invalid'
  for (const p of PACKAGES) {
    if (!isNum(e.multiplier?.[p]) || e.multiplier[p] < 0) return `Early-start multiplier (${PACKAGE_LABELS[p]}) must be a number ≥ 0`
  }
  return null
}
