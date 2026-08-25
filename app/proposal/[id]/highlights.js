// Which service rows the compare block opens on, when the URL does not say.
//
// THE RULE. A row is highlighted when the offered tiers give DIFFERENT answers
// for it. That is the whole rule, in three clauses:
//   (a) a base service whose per-tier lines are not all identical — meetings
//       cadence, Common App support, supplements rounds, essay turnaround,
//       waitlist and appeals, and so on;
//   (b) an add-on that is on in at least one offered tier but not on the same
//       terms in all of them — it appears at a tier (internship, solo project),
//       or its count changes (5 extra colleges to 10);
//   (c) an add-on that is a service at one tier and a free BONUS at another.
// A service every offered tier answers identically is NOT highlighted: it
// cannot help anyone choose between them. It is one chip-tap away, it is in the
// "Show everything" view, and its verbatim line is in the letter below.
//
// EVIDENCE FOR THE RULE (six-quote audit, 2026-08-24). Across every proposal
// Ryan has ever built, the add-on grid is byte-identical: Essential gets
// extraCollege / competitions5 / groupProject / groupSat; Comprehensive adds
// internship and takes extraCollege from 5 to 10; VIP adds soloProject and
// moves groupProject into the free-bonus column. A 9th grader got the same grid
// as the 11th graders — so GRADE carries no chip signal at all, which is what
// retired the grade table this function originally shipped with. Grade still
// drives the narrative copy (SEASON_ACCOMPLISH, WHY_NOW) in lib/packageContent
// .js; it just does not decide what a family should compare.
//
// WHAT WOULD REPLACE THIS. Nothing, unless the evidence changes. The rule is
// already derived from the saved quote rather than guessed from the student, so
// the next honest upgrade is a signal Ryan authors deliberately — a "highlight
// this" flag in the builder — not a cleverer inference. If the add-on grid ever
// stops being uniform across proposals, re-run the audit before touching this.

import { computeQuote } from '@/lib/pricingCalc'
import { ADDON_DEFS, normalizeSelectedPackages } from '@/lib/pricingSchema'
import { addonSlug, baseServiceRows } from './serviceCatalog'

// A tier's answer for one add-on, as a comparable string. Read from the QUOTE's
// own line items rather than from the raw selection, so the page can never
// highlight something the calculator did not actually price. `count` is null
// for a checkbox add-on, which is why the marker is in the string.
function addonSignature(quotePackage, key) {
  const svc = (quotePackage?.serviceLines || []).find((l) => l.key === key)
  if (svc) return `service:${svc.count === null ? 'on' : svc.count}`
  const bonus = (quotePackage?.bonusLines || []).find((l) => l.key === key)
  if (bonus) return `bonus:${bonus.count === null ? 'on' : bonus.count}`
  return 'off'
}

export function defaultHighlights(selection, config, quoteTotals) {
  const offered = normalizeSelectedPackages(selection?.selectedPackages)
  // quoteTotals is passed in by the page (one computeQuote per request); the
  // fallback keeps this function callable on its own, which is what makes the
  // rule testable against a stored selection without rendering anything.
  const quote = quoteTotals || computeQuote(selection || {}, config, null)
  const slugs = []

  // (a) base services whose tier answers disagree.
  for (const row of baseServiceRows(offered)) {
    const answers = row.cells.map((c) => c.text)
    if (!answers.every((a) => a === answers[0])) slugs.push(row.slug)
  }

  // (b) + (c) add-ons that are on somewhere, and either differ across the
  // offered tiers or change from a paid service into a free bonus.
  for (const def of ADDON_DEFS) {
    const signatures = offered.map((pkg) => addonSignature(quote.packages?.[pkg], def.key))
    if (signatures.every((s) => s === 'off')) continue
    const varies = !signatures.every((s) => s === signatures[0])
    const becomesBonus = signatures.some((s) => s.startsWith('bonus:'))
    if (varies || becomesBonus) slugs.push(addonSlug(def.key))
  }

  return slugs
}

/* ── the three slots ──────────────────────────────────────────────────────────
   defaultHighlights answers "which services can help anyone choose"; it does not
   rank them, and it routinely returns nine or ten. The page has three slots, so
   something has to decide which three a family sees first.

   RELEVANCE_ORDER is that decision, and it is a JUDGMENT, not a derivation: it
   is the order the questions actually arrive in on a consult call. Meetings and
   the college list are what a family asks about before they ask about anything
   else; parent communication and the waitlist matter, but nobody opens with
   them. Written as an explicit list rather than inferred from the data, because
   there is nothing in the quote that encodes "what a parent asks first" and a
   formula pretending otherwise would be a guess wearing arithmetic's clothes.

   Add-ons are deliberately absent from the list. They sort after every base
   service, in the catalog's own order, so a slot only opens on an add-on when
   fewer than three base services differ between the tiers. */
const RELEVANCE_ORDER = [
  'meetings',
  'college-list',
  'common-app-support',
  'supplements-5-schools',
  'activity-planning',
  'summer-planning',
  'academic-blueprint',
  'monitoring-accountability',
  'essay-turnaround',
  'parent-communication',
  'waitlist-appeals',
]

// The three services the page opens on: the ones that differ between the
// offered tiers, most-asked-about first. Padded from the catalog when fewer
// than three differ (a one-tier proposal highlights nothing at all), so the
// three slots always hold three real services rather than rendering empty.
export function defaultSlots(catalog, highlights, count = 3) {
  const valid = catalog.map((row) => row.slug)
  const rank = (slug) => {
    const i = RELEVANCE_ORDER.indexOf(slug)
    return i === -1 ? RELEVANCE_ORDER.length + valid.indexOf(slug) : i
  }
  const picked = highlights.filter((s) => valid.includes(s)).sort((a, b) => rank(a) - rank(b))
  const out = []
  for (const slug of picked) if (out.length < count && !out.includes(slug)) out.push(slug)
  for (const slug of [...valid].sort((a, b) => rank(a) - rank(b))) {
    if (out.length >= count) break
    if (!out.includes(slug)) out.push(slug)
  }
  return out
}
