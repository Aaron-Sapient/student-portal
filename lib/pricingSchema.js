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

// Ryan presents one, two or three tiers per family. Everything downstream reads
// the normalized subset rather than PACKAGES, so a proposal never mentions a
// package the family was not offered.
//
// Always returns tiers in PACKAGES order (cheapest first) regardless of the
// order they were selected in, because the email numbers its options by
// position. An absent or malformed selection falls back to all three, which
// keeps every existing caller and every quote saved before this field existed
// rendering exactly as before.
//
// ⚠ An explicitly EMPTY array also falls back to all three, because a renderer
// has no better move — but that makes "Ryan deselected every tier" render as a
// full three-option proposal including VIP, silently. Whatever UI eventually
// writes this field MUST prevent an empty selection at the control, rather than
// relying on this function to be meaningful about it.
export function normalizeSelectedPackages(input) {
  if (!Array.isArray(input)) return [...PACKAGES]
  const wanted = new Set(input.filter((p) => PACKAGES.includes(p)))
  const ordered = PACKAGES.filter((p) => wanted.has(p))
  return ordered.length ? ordered : [...PACKAGES]
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

// One empty selection bucket per package — the shape a preset's `services` and
// `bonuses` each take. Sparse: no add-on keys until Ryan sets some.
function emptyPerPackage() {
  return Object.fromEntries(PACKAGES.map((p) => [p, {}]))
}

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
    // Ceiling on the STACKING discounts only — per-add-on + referral + sibling +
    // custom. The late-start discount is NOT in the stack: Ryan sets those dollar
    // amounts himself and they adjust the base rather than stacking on it, so a
    // winter quote can still print a total percentage above this number.
    // (Ryan's intent, confirmed via Aaron 2026-08-06.)
    maxStackPct: 25,
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
  // Payment structure per package (Output B94:B96). Each string completes the
  // sentence "<Package> ($X,XXX): …", so it starts lowercase and ends with a
  // period. Lifted out of hardcoded prose in lib/packageEmail.js on 2026-08-10:
  // when Ryan presents a single tier, that tier still has to state its own
  // terms, which three hardcoded sentences could not do.
  paymentTerms: {
    essential: 'typically due in full upon enrollment.',
    comprehensive:
      'may be split into 2 payments, 30 days apart. The full balance must be paid within 30 days of enrollment.',
    vip: 'may be split into 3 payments, each 30 days apart. The full balance must be paid within 60 days of enrollment.',
  },
  // Packages eligible for the pay-in-full incentive. The proposal omits the
  // whole block when none of the presented packages is eligible, rather than
  // advertising an incentive against tiers the family was not offered.
  payInFullPackages: ['comprehensive', 'vip'],
  // Per-grade starting selections for the builder, so a proposal begins from
  // Ryan's usual recommendation instead of 78 empty cells.
  //
  // Sparse by design: an absent add-on key is an unselected add-on, matching
  // what buildLines/isActive already do with undefined. Values use the same
  // shape as a builder selection — a count for `count`/`perPackageCount`
  // add-ons, a boolean for `flat` ones.
  //
  // Ships EMPTY on purpose. Which add-ons belong in a 10th-grade standard offer
  // is Ryan's call, not a default worth guessing; populating these is a
  // one-pass conversation with him, and the natural authoring path is a "save
  // current selection as this grade's preset" control in the builder. Until
  // then an empty preset is inert — it selects nothing, exactly as today.
  presets: {
    9: { label: '9th standard', services: emptyPerPackage(), bonuses: emptyPerPackage() },
    10: { label: '10th standard', services: emptyPerPackage(), bonuses: emptyPerPackage() },
    11: { label: '11th standard', services: emptyPerPackage(), bonuses: emptyPerPackage() },
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
    paymentTerms: { ...d.paymentTerms, ...stored.paymentTerms },
    // An explicit empty array is meaningful ("no tier gets the incentive"), so
    // only a non-array falls back to the default.
    payInFullPackages: Array.isArray(stored.payInFullPackages)
      ? stored.payInFullPackages.filter((p) => PACKAGES.includes(p))
      : [...d.payInFullPackages],
    presets: mergePresets(stored.presets, d.presets),
  }
}

// Presets merge per grade and per package, so adding a grade or a package to
// the defaults never strands a stored config on the old shape.
function mergePresets(stored, defaults) {
  const out = {}
  for (const g of GRADES) {
    const s = stored?.[g]
    const dg = defaults[g] || { label: `${g}th standard`, services: emptyPerPackage(), bonuses: emptyPerPackage() }
    out[g] = {
      label: typeof s?.label === 'string' && s.label.trim() ? s.label : dg.label,
      services: mergeBucket(s?.services, dg.services),
      bonuses: mergeBucket(s?.bonuses, dg.bonuses),
    }
  }
  return out
}

function mergeBucket(stored, defaults) {
  return Object.fromEntries(
    PACKAGES.map((p) => [p, { ...(defaults?.[p] || {}), ...(stored?.[p] || {}) }])
  )
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
    ['maxStackPct', 'Maximum stacked discount'],
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

  // The fields below validate ONLY when present. The route validates the raw
  // POST body rather than a merged config, and mergeConfig supplies a default
  // for each of these on read — so requiring them here would reject a config
  // posted by any client that predates them.
  if (c.paymentTerms !== undefined) {
    if (typeof c.paymentTerms !== 'object' || c.paymentTerms === null) return 'Payment terms must be an object'
    for (const p of PACKAGES) {
      const v = c.paymentTerms[p]
      if (v !== undefined && (typeof v !== 'string' || !v.trim())) {
        return `Payment terms (${PACKAGE_LABELS[p]}) must be a non-empty string`
      }
    }
  }
  if (c.payInFullPackages !== undefined) {
    if (!Array.isArray(c.payInFullPackages)) return 'Pay-in-full packages must be a list'
    for (const p of c.payInFullPackages) {
      if (!PACKAGES.includes(p)) return `Pay-in-full packages contains an unknown package "${p}"`
    }
  }
  if (c.presets !== undefined) {
    if (typeof c.presets !== 'object' || c.presets === null) return 'Presets must be an object'
    const addOnKeys = new Set(ADDON_DEFS.map((d) => d.key))
    for (const g of Object.keys(c.presets)) {
      if (!GRADES.includes(g)) return `Presets contains an unknown grade "${g}"`
      for (const bucket of ['services', 'bonuses']) {
        const b = c.presets[g]?.[bucket]
        if (b === undefined) continue
        if (typeof b !== 'object' || b === null) return `Preset ${g}th ${bucket} must be an object`
        for (const p of Object.keys(b)) {
          if (!PACKAGES.includes(p)) return `Preset ${g}th ${bucket} contains an unknown package "${p}"`
          const sel = b[p]
          if (sel === undefined) continue
          if (typeof sel !== 'object' || sel === null) return `Preset ${g}th ${bucket} (${PACKAGE_LABELS[p]}) must be an object`
          for (const [k, v] of Object.entries(sel)) {
            if (!addOnKeys.has(k)) return `Preset ${g}th ${bucket} contains an unknown add-on "${k}"`
            if (typeof v !== 'boolean' && !(isNum(v) && v >= 0)) {
              return `Preset ${g}th ${bucket} value for "${k}" must be a boolean or a number ≥ 0`
            }
          }
        }
      }
    }
  }
  return null
}

// Two proposals are "for the same student" when their names match ignoring
// case and runs of whitespace. Deliberately NOT fuzzy: a near-match that
// silently overwrote a different family's proposal would be far worse than one
// extra row, so anything short of the same name is a new student. NFC first —
// "José" typed on iOS and pasted from a macOS source are different byte
// sequences for the same name.
//
// Lives in this client-safe module because both sides need it: the server
// matches saved rows with it, and the builder uses it to tell whether the name
// still refers to the proposal it has open.
export const studentNameKey = (s) =>
  String(s || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
