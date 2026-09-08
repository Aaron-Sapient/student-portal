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
// 2026-27 ladder (ratified Aaron + Ryan, 2026-08-31). Essential is REMOVED,
// not closed: it must not be quotable, so it is gone from PACKAGES entirely.
// A historical quote that offered it keeps its email_html as the record; this
// engine deliberately cannot re-derive an Essential tier.
export const PACKAGES = ['comprehensive', 'vip', 'uvip']
export const PACKAGE_LABELS = {
  comprehensive: 'Comprehensive',
  vip: 'VIP',
  uvip: 'UVIP',
}
// Closed = shown but not offered to new families (the printed price is a
// deliberate anchor, and a pricing-hold family may still need one rendered).
// Presentation + default-offer wiring only, never a hard lock.
export const CLOSED_PACKAGES = ['comprehensive']
// UVIP is all-inclusive and unmetered: no add-on is ever sold or gifted on it,
// so add-on grids and add-on pricing UI iterate this list instead of PACKAGES.
export const ADDON_PACKAGES = ['comprehensive', 'vip']
// What a NEW proposal offers when Ryan has not picked tiers: VIP only.
// Comprehensive is closed and UVIP is by-conversation (its number is
// inquire-only in family-facing material).
export const DEFAULT_OFFERED = ['vip']
// How a LEGACY selection (saved under the 3-tier model, before the builder
// wrote selectedPackages) is read: the surviving members of the old default
// trio. Provisioning an Essential acceptance fails loudly at the tier check
// rather than silently re-tiering the family.
export const LEGACY_OFFERED = ['comprehensive', 'vip']

// Ryan presents one or more tiers per family. Everything downstream reads the
// normalized subset rather than PACKAGES, so a proposal never mentions a
// package the family was not offered.
//
// Always returns tiers in PACKAGES order (cheapest first) regardless of the
// order they were selected in, because the email numbers its options by
// position.
//
// The fallback is LEGACY_OFFERED, not PACKAGES: a row carrying no
// `selectedPackages` was saved under the 3-tier model, and Comprehensive + VIP
// are the surviving members of that trio. The builder always writes the field,
// so a row saved by it never reaches this fallback. An Essential-only legacy
// selection is unrepresentable here; it fails loudly at the provision tier
// check rather than being silently re-tiered into something the family never
// bought.
//
// ⚠ An explicitly EMPTY array also falls back, because a renderer has no better
// move — but that makes "Ryan deselected every tier" render as a two-option
// proposal, silently. The UI that writes this field MUST prevent an empty
// selection at the control rather than rely on this function to be meaningful
// about it; the builder's Tiers offered chips do that by refusing to deselect
// the last tier (app/dev/packages/PackageBuilder.js).
export function normalizeSelectedPackages(input) {
  if (!Array.isArray(input)) return [...LEGACY_OFFERED]
  const wanted = new Set(input.filter((p) => PACKAGES.includes(p)))
  const ordered = PACKAGES.filter((p) => wanted.has(p))
  return ordered.length ? ordered : [...LEGACY_OFFERED]
}

// The tiers a proposal on `preset` actually presents: what Ryan selected,
// narrowed to what that card can price.
//
// normalizeSelectedPackages filters against PACKAGES — TODAY's tier set — so on
// its own it will hand back a tier the active card never had. A row pairing
// pricingPreset:'legacy2025' with a stored UVIP selection rendered "Option 3:
// 10th UVIP … $75,050": today's UVIP base wearing the legacy card's discount
// rules, a hybrid that has never existed anywhere. The builder's controls
// cannot produce that pairing, but `selection` is unvalidated JSONB and
// fromSelection carries both fields verbatim, so a hand-written or API-written
// row reaches it. packageEmail's own header forbids iterating PACKAGES for
// exactly this reason; this is that rule one level down, inside the helper it
// trusts.
//
// For the current card `offerPackages` IS PACKAGES, so this is the identity
// function and nothing about a current-card proposal moves.
export function offeredOn(preset, selectedPackages) {
  const normalized = normalizeSelectedPackages(selectedPackages)
  const narrowed = normalized.filter((p) => preset.offerPackages.includes(p))
  return narrowed.length ? narrowed : [...preset.defaultOffered]
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
  // 2026-27 ladder, ratified Aaron + Ryan 2026-08-31. These are the merge
  // fallback, not a dead default: mergeConfig fills any key the stored
  // pricing_config row predates, so a package absent from that row (UVIP) is
  // priced from here with no row edit. A package the row DOES carry keeps the
  // row's number.
  base: {
    9: { comprehensive: 29000, vip: 52000, uvip: 99000 },
    10: { comprehensive: 26000, vip: 44000, uvip: 79000 },
    11: { comprehensive: 21000, vip: 36000, uvip: 59000 },
  },
  addOns: {
    // per school. UVIP's 0 is inert: no add-on is ever sold or gifted on that
    // tier, and the entry exists only so the generic per-package validators and
    // the calculator have a number to read.
    extraCollege: { comprehensive: 750, vip: 1000, uvip: 0 },
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
  // UVIP is 0 in every window and stays 0: an all-inclusive tier does not
  // discount seasonally.
  lateStart: [
    { label: 'Fall (Oct–Dec)', startMonth: 10, endMonth: 12, comprehensive: 1000, vip: 1500, uvip: 0 },
    { label: 'Winter (Jan–Mar)', startMonth: 1, endMonth: 3, comprehensive: 2000, vip: 3000, uvip: 0 },
    { label: 'Spring/Summer (Apr–Sep)', startMonth: 4, endMonth: 9, comprehensive: 0, vip: 0, uvip: 0 },
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
    // UVIP's 0 also suppresses the early-start paragraph whenever UVIP tops an
    // offer: quantifying free weeks of service against an unmetered tier states
    // nothing.
    multiplier: { comprehensive: 0.5, vip: 1, uvip: 0 },
  },
  // Payment structure is NOT stored per package any more — installment
  // eligibility follows the quote TOTAL. See INSTALLMENT_BANDS and
  // paymentTermsForTotal() below.
  // Packages eligible for the pay-in-full incentive. The proposal omits the
  // whole block when none of the presented packages is eligible, rather than
  // advertising an incentive against tiers the family was not offered. A CLOSED
  // tier must not advertise an incentive, so it is absent here; a stored row
  // naming one still resolves, because mergeConfig filters that list to
  // PACKAGES membership rather than to what is offered.
  payInFullPackages: ['vip'],
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

// --- Installment eligibility -------------------------------------------------
//
// Eligibility follows the quote TOTAL, never the tier — Claude_Services.md §7
// "Installment eligibility" (2026-27 refresh · Aaron 2026-08-31), whose
// family-facing encoding is ap-checkout /terms §6:
//   under $35,000 — payment is due in full upon enrollment
//   $35,000+      — up to 2 payments, 30 days apart, balance within 30 days
//   $50,000+      — up to 3 payments, 30 days apart, balance within 60 days
//
// The shape this replaces (Output B94:B96) stored one sentence PER PACKAGE, so
// the 2026-27 tier ladder moved under the thresholds while the strings stayed
// put: a $30,150 Comprehensive was offered 2 payments and a $41,400 VIP was
// offered 3. A per-tier string cannot express a rule keyed to the total, which
// is why this is a function and not config.
//
// Highest band first; the first band the total reaches wins.
export const INSTALLMENT_BANDS = [
  { minTotal: 50000, payments: 3, balanceDays: 60 },
  { minTotal: 35000, payments: 2, balanceDays: 30 },
  { minTotal: 0, payments: 1, balanceDays: 0 },
]

export function installmentBandForTotal(total) {
  const amount = Number.isFinite(Number(total)) ? Number(total) : 0
  return INSTALLMENT_BANDS.find((b) => amount >= b.minTotal) || INSTALLMENT_BANDS[INSTALLMENT_BANDS.length - 1]
}

// Completes the sentence "<Package> ($X,XXX): …" that lib/packageEmail.js
// prints, so it starts lowercase and ends with a period.
//
// `pkg` selects FRAMING only, never the installment count. UVIP keeps its own
// framing for a documented reason — Ultra VIP pricing is structured in
// conversation and never published (Claude_Services.md §7 "Ultra VIP price
// disclosure") — but its count now derives from the total like every other
// tier, so a discounted UVIP below $50k stops promising three payments.
export function paymentTermsForTotal(total, pkg) {
  const { payments, balanceDays } = installmentBandForTotal(total)
  if (pkg === 'uvip') {
    return payments === 1
      ? 'is structured directly with your family, and is due in full upon enrollment.'
      : `is structured directly with your family, typically as up to ${payments} payments 30 days apart, with the full balance due within ${balanceDays} days of enrollment.`
  }
  if (payments === 1) return 'is due in full upon enrollment.'
  return `may be split into up to ${payments} payments, 30 days apart. The full balance must be paid within ${balanceDays} days of enrollment.`
}

// The FROZEN 2025-26 card — the pricing a family quoted before the 2026-08-31
// refresh actually saw. Kept so Ryan can still send a proposal on the terms a
// family was already given (Aaron's ruling 2026-09-08: a family who has already
// seen a legacy price, installment term or incentive gets whichever version is
// most in their favour; a family seeing it for the first time gets the current
// one). AP-Counseling `Claude_Services.md` §7 carries that ruling in prose.
//
// PROVENANCE — three independent sources, all agreeing (2026-09-08):
//   1. package_quotes.config_snapshot on every proposal saved under this card
//      (four rows, 2026-08-11 → 2026-08-22, byte-identical to each other);
//   2. DEFAULT_PRICING as it stood at commit c5a6592^ (the pre-refresh tree);
//   3. the pre-refresh pamphlet backup, `AP-Counseling/03. Pamphlets/Business
//      Promotions/High School Packages - Grades 9-11.html.bak-2026-08-26`.
// The only fields that differ from today's live config are `base` and
// `paymentTerms`; add-ons, discount rates, the seasonal ladders and the
// early-start window were untouched by the refresh (diffed against the live
// pricing_config row, 2026-09-08).
//
// FROZEN IN CODE, deliberately, rather than as a second Supabase row: every
// family this card can still be quoted to is a family who saw these exact
// numbers, so an editable copy would reintroduce precisely the drift that
// config_snapshot exists to prevent. It must never move again.
export const LEGACY_2025_26 = {
  base: {
    9: { comprehensive: 12500, vip: 19500, uvip: 99000 },
    10: { comprehensive: 10500, vip: 16500, uvip: 79000 },
    11: { comprehensive: 8500, vip: 13500, uvip: 59000 },
  },
  // UVIP did not exist in 2025-26 and cannot be quoted on this card — see
  // `offerPackages` on the preset below, which is what the builder iterates.
  // The base entries above exist only so validatePricing and the calculator
  // (which both loop PACKAGES) have a number to read; they carry today's UVIP
  // figures rather than a 0, so a misuse would be visibly wrong rather than
  // quietly free.
  addOns: {
    extraCollege: { comprehensive: 750, vip: 1000, uvip: 0 },
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
    perAddOnPct: 2,
    referralPct: 5,
    siblingPct: 5,
    maxStackPct: 25,
    earlyStartRate: 500,
  },
  lateStart: [
    { label: 'Fall (Oct–Dec)', startMonth: 10, endMonth: 12, comprehensive: 1000, vip: 1500, uvip: 0 },
    { label: 'Winter (Jan–Mar)', startMonth: 1, endMonth: 3, comprehensive: 2000, vip: 3000, uvip: 0 },
    { label: 'Spring/Summer (Apr–Sep)', startMonth: 4, endMonth: 9, comprehensive: 0, vip: 0, uvip: 0 },
  ],
  earlyStart: {
    applyStartMonth: 4,
    applyStartDay: 1,
    applyEndMonth: 8,
    applyEndDay: 31,
    targetMonth: 9,
    targetDay: 1,
    multiplier: { comprehensive: 0.5, vip: 1, uvip: 0 },
  },
  // Tier-keyed installments — the legacy rule, and the reason this preset
  // cannot simply reuse the engine's terms. The 2026-27 refresh moved
  // eligibility to a PRICE milestone, and as of cf9c0cb the current card no
  // longer stores terms at all: paymentTermsForTotal() derives them from the
  // quote total. A per-tier string cannot express that rule — and the total
  // rule cannot express THIS one, which is keyed to the tier and to nothing
  // else. A family promised "3 payments on VIP" was promised it under the
  // sentence below, at a $39,100 total that today's bands would answer with
  // two. So these survive as the legacy preset's own terms (see
  // PRICING_PRESETS.legacy2025.paymentTerms), not as config the renderer
  // merges.
  paymentTerms: {
    comprehensive:
      'may be split into 2 payments, 30 days apart. The full balance must be paid within 30 days of enrollment.',
    vip: 'may be split into 3 payments, each 30 days apart. The full balance must be paid within 60 days of enrollment.',
    uvip: 'is structured directly with your family, typically as 3 payments 30 days apart, with the full balance due within 60 days of enrollment.',
  },
  // Comprehensive was open in 2025-26 and DID advertise the pay-in-full
  // incentive. The incentive's own wording (tiered $500 / $1,000 by whether the
  // program is above $25,000) is prose in packageContent.js, which still states
  // the legacy version — correct for this card, and see the note on
  // STATIC.payInFullBody for the current card.
  payInFullPackages: ['comprehensive', 'vip'],
}

// --- Pricing presets -------------------------------------------------------
// A proposal renders against exactly ONE named pricing card, recorded on the
// quote's `selection` blob as `pricingPreset` so a re-render is stable and a
// saved row says on its face which card it was priced from.
//
// `current` carries no config of its own: it IS the live Supabase
// pricing_config row, so Ryan's edits on the Pricing tab keep flowing through
// untouched. Only `legacy2025` substitutes a card, and it substitutes a frozen
// one.
export const PRICING_PRESETS = {
  current: {
    key: 'current',
    label: 'Current (2026-27)',
    hint: 'The live card from the Pricing tab.',
    config: null,
    offerPackages: PACKAGES,
    closedPackages: CLOSED_PACKAGES,
    defaultOffered: DEFAULT_OFFERED,
  },
  legacy2025: {
    key: 'legacy2025',
    label: 'Legacy (2025-26)',
    hint: 'Frozen pre-refresh card, for a family already quoted on it.',
    config: LEGACY_2025_26,
    // Essential is gone from PACKAGES and cannot be re-derived (see the note
    // there), so a legacy proposal offers the two tiers that survived. UVIP did
    // not exist under this card.
    offerPackages: LEGACY_OFFERED,
    // Nothing was closed in 2025-26, so Comprehensive advertises the
    // pay-in-full incentive here exactly as it did then.
    closedPackages: [],
    defaultOffered: LEGACY_OFFERED,
    // Installments keyed to the TIER, which is what these families were shown.
    // Present only on this preset: an absent `paymentTerms` means "derive from
    // the total", which is the current card's rule.
    paymentTerms: LEGACY_2025_26.paymentTerms,
    // The tiered incentive, retired on the current card by 0654f9f. It is not
    // dead prose: it is what a legacy family was told, and at a $17,518
    // Comprehensive the $500 half genuinely fires — the half the current ladder
    // leaves unreachable.
    payInFullBody:
      'If paid in full upfront, A|P may apply a one-time incentive of $500 for programs priced at $25,000 or less, or $1,000 for programs priced above $25,000.',
  },
}
export const DEFAULT_PRESET = 'current'

// Never throws and never returns undefined. `Object.hasOwn`, not a plain index:
// a bare lookup walks the prototype chain, so a row carrying
// pricingPreset:"constructor" (or "toString", "__proto__", …) resolved to a
// function with no offerPackages and crashed every reader of it. `selection` is
// unvalidated JSONB, so that is a storable value, not a hypothetical.
export function presetFor(key) {
  return Object.hasOwn(PRICING_PRESETS, key) ? PRICING_PRESETS[key] : PRICING_PRESETS[DEFAULT_PRESET]
}

// The card a SAVED row was priced on. An explicit `pricingPreset` wins; without
// one the row's own `config_snapshot` is asked, because "no preset field" does
// NOT mean "current card" — every proposal saved before 2026-08-31 predates the
// field AND predates the refresh, so reading it as current is exactly backwards
// for the rows this preset exists to serve. Reopening Diya Sindol's August
// proposal was repricing her 11th VIP from $13,500 to $36,000 in silence.
//
// The snapshot is matched on base prices alone: they are the only field the
// refresh moved that is present on every stored snapshot, and a partial match
// is not a thing — the ladder moved as one ratified block.
export function presetForSavedQuote(row) {
  const explicit = row?.selection?.pricingPreset
  if (explicit) return presetFor(explicit)
  const base = row?.config_snapshot?.base
  if (!base) return PRICING_PRESETS[DEFAULT_PRESET]
  const legacy = LEGACY_2025_26.base
  const isLegacy = GRADES.every((g) => LEGACY_OFFERED.every((p) => Number(base[g]?.[p]) === legacy[g][p]))
  return isLegacy ? PRICING_PRESETS.legacy2025 : PRICING_PRESETS[DEFAULT_PRESET]
}

// The payment-terms sentence for one tier of a proposal on `preset`.
//
// A preset carrying its own `paymentTerms` states them by TIER (the legacy
// rule); everything else derives them from the quote TOTAL via
// paymentTermsForTotal, which is the current rule and the only one the engine
// had before presets existed. The current preset carries none, so it takes the
// derived branch and its output is unchanged.
export function paymentTermsFor(preset, total, pkg) {
  const byTier = preset?.paymentTerms?.[pkg]
  return typeof byTier === 'string' && byTier.trim() ? byTier : paymentTermsForTotal(total, pkg)
}

// The pay-in-full sentence for a proposal on `preset`. A preset may pin its
// own; otherwise the caller's default (packageContent's STATIC.payInFullBody,
// the current flat $1,000) stands.
export function payInFullBodyFor(preset, fallback) {
  const own = preset?.payInFullBody
  return typeof own === 'string' && own.trim() ? own : fallback
}

// The config a proposal on this preset renders against. `liveConfig` is the
// already-merged live row (readPricing() on the server, DevDataContext in the
// browser); a preset carrying its own card is merged the same way so both
// paths hand the calculator an identically-shaped object.
export function resolvePricing(key, liveConfig) {
  const preset = presetFor(key)
  return preset.config ? mergeConfig(preset.config) : liveConfig
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
    lateStart: normalizeLateStartWindows(stored.lateStart, d.lateStart),
    earlyStart: {
      ...d.earlyStart,
      ...stored.earlyStart,
      multiplier: { ...d.earlyStart.multiplier, ...stored.earlyStart?.multiplier },
    },
    // Retired from rendering: the email derives installment terms from the
    // quote total (paymentTermsForTotal). A row saved before that still
    // round-trips through here rather than being silently dropped on save, but
    // nothing reads it and there are no defaults to merge under it.
    paymentTerms: { ...stored.paymentTerms },
    // An explicit empty array is meaningful ("no tier gets the incentive"), so
    // only a non-array falls back to the default.
    payInFullPackages: Array.isArray(stored.payInFullPackages)
      ? stored.payInFullPackages.filter((p) => PACKAGES.includes(p))
      : [...d.payInFullPackages],
    presets: mergePresets(stored.presets, d.presets),
  }
}

// A stored window predates any package added after it was saved (UVIP,
// 2026-08-31), and every such window is missing that package's amount. Filling
// it from the defaults keeps the window valid under validatePricing's
// per-package check and keeps the calculator reading a number: an absent amount
// would otherwise fail validation outright, or reach lateStartFor as undefined.
// Whatever the stored window already carries wins.
function normalizeLateStartWindows(stored, defaults) {
  if (!Array.isArray(stored) || !stored.length) return clone(defaults)
  return stored.map((w, i) => ({
    ...Object.fromEntries(PACKAGES.map((p) => [p, Number(defaults[i]?.[p]) || 0])),
    ...w,
  }))
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
