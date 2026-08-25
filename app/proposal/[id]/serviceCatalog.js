// The proposal page's unit of comparison: the SERVICE, with the offered tiers
// as its answers.
//
// The email is a linear document, so it says the same eleven services three
// times, once per tier. A family reading it is asking the transposed question —
// "for THIS service, what do the three tiers do?" — and this module is the
// catalog that lets the page answer it: one row per service, one cell per
// offered tier.
//
// PROVENANCE, and why nothing here is written by hand. Base-service rows are
// parsed out of `PACKAGE_INCLUDED` in lib/packageContent.js, which is Ryan's
// verbatim copy, so a cell's text is a substring of the email's own line and a
// copy edit over there moves this in lockstep. Add-on rows come from
// `ADDON_DEFS` in lib/pricingSchema.js — the same list the calculator prices —
// and their per-tier answers are read from the saved selection, never inferred.
// Retyping either list here would be a second implementation of the catalog,
// and the two would silently disagree the first time one of them changed.

import { ADDON_DEFS, PACKAGES } from '@/lib/pricingSchema'
import { PACKAGE_INCLUDED } from '@/lib/packageContent'

// URL slug for a base service, derived from its own label. The labels are
// exported constants, so these are stable; a copy edit to a label WOULD change
// its slug and stale `?s=` links would drop that one row, which is a visible,
// recoverable failure rather than a silent wrong answer.
export function serviceSlug(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

// URL slug for an add-on, derived from its schema KEY rather than its label, so
// it survives a label rewording: competitions5 → competitions-5, seniorAp10 →
// senior-ap-10, extraCollege → extra-college.
export function addonSlug(key) {
  return String(key || '')
    .replace(/([a-z])([A-Z0-9])/g, '$1-$2')
    .replace(/([0-9])([A-Za-z])/g, '$1-$2')
    .toLowerCase()
}

// " - Meetings: Monthly 1 to 1" → Map { 'Meetings' → 'Monthly 1 to 1' }.
function includedMap(pkg) {
  const out = new Map()
  for (const raw of String(PACKAGE_INCLUDED[pkg] || '').split('\n')) {
    const line = raw.replace(/^\s*-\s+/, '').trim()
    if (!line) continue
    const at = line.indexOf(': ')
    if (at === -1) continue
    out.set(line.slice(0, at), line.slice(at + 2))
  }
  return out
}

// The eleven base services, in the order Ryan lists them, with one cell per
// offered tier. Order is taken as the union across ALL packages rather than
// from `essential` alone: today the three lists match line for line, and if one
// of them ever gains a service, the row should appear with the others reading
// "Not included" instead of vanishing from the page.
export function baseServiceRows(offered) {
  const maps = Object.fromEntries(PACKAGES.map((p) => [p, includedMap(p)]))
  const order = []
  for (const p of PACKAGES) {
    for (const label of maps[p].keys()) if (!order.includes(label)) order.push(label)
  }
  return order.map((label) => ({
    kind: 'base',
    key: label,
    slug: serviceSlug(label),
    label,
    cells: offered.map((pkg) => {
      const text = maps[pkg].get(label)
      return { pkg, text: text || 'Not included', tone: text ? 'on' : 'off' }
    }),
  }))
}

// A selection value that actually counts: a count ≥ 1, or a checked box. Same
// test lib/pricingCalc.js applies before it prices anything, kept in the same
// shape so a row can never claim a service the quote did not charge for.
function activeCount(def, value) {
  if (def.kind === 'flat') return value ? 1 : 0
  const n = Number(value) || 0
  return n >= 1 ? n : 0
}

// One add-on's answer for one tier. Three states, and each is a real answer a
// family asked for: bought with the package, handed over as a sign-on bonus, or
// not part of this tier at all.
function addonCell(def, selection, pkg) {
  const asService = activeCount(def, selection?.services?.[pkg]?.[def.key])
  if (asService) {
    return { pkg, tone: 'on', text: def.kind === 'flat' ? 'Included' : `${asService}, included` }
  }
  const asBonus = activeCount(def, selection?.bonuses?.[pkg]?.[def.key])
  if (asBonus) {
    return { pkg, tone: 'bonus', text: def.kind === 'flat' ? 'Free bonus' : `${asBonus}, free bonus` }
  }
  return { pkg, tone: 'off', text: 'Not offered' }
}

export function addonRows(selection, offered) {
  return ADDON_DEFS.map((def) => {
    const cells = offered.map((pkg) => addonCell(def, selection, pkg))
    return {
      kind: 'addon',
      key: def.key,
      slug: addonSlug(def.key),
      label: def.label,
      cells,
      // An add-on nobody is being offered still gets a row (a family who asks
      // "do you do AP tutoring?" deserves the answer on the page), but it stays
      // out of the chip rail, which is for choosing between the tiers.
      offeredSomewhere: cells.some((c) => c.tone !== 'off'),
    }
  })
}

// Base services first, then add-ons: the package is what the family is buying,
// and the add-ons are what was put on top of it.
export function buildCatalog(selection, offered) {
  return [...baseServiceRows(offered), ...addonRows(selection, offered)]
}

/* ── the glyphs ────────────────────────────────────────────────────────────────
   One icon per service, so a section on the compare page is marked by an object
   rather than by another line of type. Vendored Lucide, verbatim: every path
   below was copied out of node_modules/lucide-react/dist/esm/icons/<name>.js, so
   the whole set sits on one grid (24×24, 2px, round caps) and none of it is
   hand-drawn. Inlined rather than imported as components because this page has
   to paint on the first frame on a phone, and a thirteen-icon import pulls the
   whole lucide-react runtime into the bundle for thirteen static paths.

   The ideograph, not the nearest neighbour: `calendar` for Meetings because the
   three answers ARE a cadence (monthly / biweekly / weekly); `life-buoy` for
   Waitlist & Appeals because that service is the safety net after a decision;
   `pencil` shared by the three SAT rows and `book-open` by the four AP-tutor
   rows because those really are one concept each, and inventing four glyphs for
   four price points would claim a distinction the services do not have.

   This map is keyed by SLUG, which is derived from a label. A copy edit to a
   label therefore drops its icon (the section still renders, unmarked) rather
   than showing the wrong one. That is the same visible-and-recoverable failure
   the slug comment above describes, on purpose. */
const I = {
  calendar: (
    <>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </>
  ),
  ruler: (
    <>
      <path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z" />
      <path d="m14.5 12.5 2-2" />
      <path d="m11.5 9.5 2-2" />
      <path d="m8.5 6.5 2-2" />
      <path d="m17.5 15.5 2-2" />
    </>
  ),
  flag: (
    <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </>
  ),
  listChecks: (
    <>
      <path d="M13 5h8" />
      <path d="M13 12h8" />
      <path d="M13 19h8" />
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
    </>
  ),
  graduationCap: (
    <>
      <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
      <path d="M22 10v6" />
      <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
    </>
  ),
  filePen: (
    <>
      <path d="M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z" />
    </>
  ),
  files: (
    <>
      <path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
      <path d="M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z" />
      <path d="M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1" />
    </>
  ),
  timer: (
    <>
      <line x1="10" x2="14" y1="2" y2="2" />
      <line x1="12" x2="15" y1="14" y2="11" />
      <circle cx="12" cy="14" r="8" />
    </>
  ),
  messageCircle: (
    <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
  ),
  lifeBuoy: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.93 4.93 4.24 4.24" />
      <path d="m14.83 9.17 4.24-4.24" />
      <path d="m14.83 14.83 4.24 4.24" />
      <path d="m9.17 14.83-4.24 4.24" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  listPlus: (
    <>
      <path d="M16 5H3" />
      <path d="M11 12H3" />
      <path d="M16 19H3" />
      <path d="M18 9v6" />
      <path d="M21 12h-6" />
    </>
  ),
  trophy: (
    <>
      <path d="M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978" />
      <path d="M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978" />
      <path d="M18 9h1.5a1 1 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z" />
      <path d="M6 9H4.5a1 1 0 0 1 0-5H6" />
    </>
  ),
  briefcase: (
    <>
      <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      <rect width="20" height="14" x="2" y="6" rx="2" />
    </>
  ),
  lightbulb: (
    <>
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <path d="M16 3.128a4 4 0 0 1 0 7.744" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <circle cx="9" cy="7" r="4" />
    </>
  ),
  pencil: (
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </>
  ),
  bookOpen: (
    <>
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </>
  ),
}

export const SERVICE_ICONS = {
  meetings: I.calendar,
  'academic-blueprint': I.ruler,
  'activity-planning': I.flag,
  'summer-planning': I.sun,
  'monitoring-accountability': I.listChecks,
  'college-list': I.graduationCap,
  'common-app-support': I.filePen,
  'supplements-5-schools': I.files,
  'essay-turnaround': I.timer,
  'parent-communication': I.messageCircle,
  'waitlist-appeals': I.lifeBuoy,
  'extra-college': I.listPlus,
  'competitions-5': I.trophy,
  'competitions-10': I.trophy,
  internship: I.briefcase,
  'solo-project': I.lightbulb,
  'group-project': I.users,
  'group-sat': I.pencil,
  'sat-popular': I.pencil,
  'sat-premium': I.pencil,
  'senior-ap-5': I.bookOpen,
  'senior-ap-10': I.bookOpen,
  'junior-ap-5': I.bookOpen,
  'junior-ap-10': I.bookOpen,
}
