// Assembles the proposal email from the calculator (lib/pricingCalc) + the
// verbatim copy (lib/packageContent), mirroring the auto-generator sheet's
// Output tab block-for-block. Returns ordered blocks plus rendered plain-text
// and rich-HTML (for clipboard paste into Gmail). Client-safe.
//
// Two sheet bugs are intentionally NOT reproduced (cleaner client email):
//   • a stray "FALSE" line in the discount summary (an empty IF with no else);
//   • baked-in wrong-gender pronouns / "{name}gets" spacing in the early-start
//     paragraph (now gender- and grade-correct, handled in lib/packageContent).

import { DEFAULT_PRICING, PACKAGE_LABELS, normalizeSelectedPackages } from './pricingSchema'
import { DateTime } from 'luxon'
import { computeQuote, money } from './pricingCalc'
import * as C from './packageContent'

const ZONE = 'America/Los_Angeles'

// Ryan presents one to three tiers per family (state.selectedPackages). The
// calculator still computes all three — only the rendering narrows — so every
// figure below is the same number it would have been in a three-option
// proposal. Nothing in this module may iterate PACKAGES directly: that is what
// leaked VIP into proposals that never offered it.

function refNow(refISO) {
  const dt = refISO ? DateTime.fromISO(refISO, { zone: ZONE }) : DateTime.now().setZone(ZONE)
  return dt.isValid ? dt : DateTime.now().setZone(ZONE)
}

// " - Included add-on (count) ($price)" list for a package (Output B20/B31/B42).
function includedAddOns(pkg, quote) {
  const lines = quote.packages[pkg].serviceLines.map((l) => `${l.label} (${money(l.amount)})`)
  if (!lines.length) return ''
  return ' - ' + lines.join('\n - ')
}

// "Bonus for X" lines (Output B9/B11/B13), incl. early-start + total (Backend R/S/T).
function bonusLines(pkg, state, config, quote) {
  const sel = state.bonuses?.[pkg] || {}
  const P = quote.packages[pkg]
  const a = config.addOns
  const out = []
  const ec = Number(sel.extraCollege) || 0
  if (ec > 0) out.push(` - ${ec} extra college${ec === 1 ? '' : 's'}, valued at ${money(a.extraCollege[pkg])} each`)
  if (sel.competitions5) out.push(` - 5 competitions, valued at ${money(a.competitions5)}`)
  if (sel.competitions10) out.push(` - 10 competitions, valued at ${money(a.competitions10)}`)
  const intern = Number(sel.internship) || 0
  if (intern > 0) out.push(` - Internship & Research (${intern}), valued at ${money(intern * a.internship)}`)
  const solo = Number(sel.soloProject) || 0
  if (solo > 0) out.push(` - Solo Passion Project (${solo}), valued at ${money(solo * a.soloProject)}`)
  const gp = Number(sel.groupProject) || 0
  if (gp > 0) out.push(` - Group Project (${gp}), valued at ${money(gp * a.groupProject)}`)
  const gs = Number(sel.groupSat) || 0
  if (gs > 0) out.push(` - Group SAT (${gs}), valued at ${money(gs * a.groupSat)}`)
  if (sel.satPopular) out.push(` - SAT Popular Combo, valued at ${money(a.satPopular)}`)
  if (sel.satPremium) out.push(` - SAT Premium Combo, valued at ${money(a.satPremium)}`)
  if (sel.seniorAp5) out.push(` - Sr. AP Tutor (5 hrs), valued at ${money(a.seniorAp5)}`)
  if (sel.seniorAp10) out.push(` - Sr. AP Tutor (10 hrs), valued at ${money(a.seniorAp10)}`)
  if (sel.juniorAp5) out.push(` - Jr. AP Tutor (5 hrs), valued at ${money(a.juniorAp5)}`)
  if (sel.juniorAp10) out.push(` - Jr. AP Tutor (10 hrs), valued at ${money(a.juniorAp10)}`)
  if (quote.earlyStartApplies && P.earlyStartValue > 0) {
    out.push(
      ` - Early Start Bonus (${quote.weeks} weeks of additional service), valued at ${money(P.earlyStartValue)} at an a-la-carte rate of ${money(config.discounts.earlyStartRate)}/hr`
    )
  }
  out.push(P.bonusTotal === 0 ? ' - No bonuses' : ` - Total value: ${money(P.bonusTotal)}`)
  return out.join('\n')
}

// "Discount for X" line (Output B24/B35/B46).
function discountLine(pkg, quote) {
  const P = quote.packages[pkg]
  // "all applicable discounts have been applied" stops being true once the stack
  // ceiling trims something, so the capped case states the ceiling instead.
  if (P.capApplied) {
    return ` - ${money(P.totalDiscount)} (${P.totalDiscountPct}%); your combined discounts reach our maximum of ${quote.maxStackPct}% off the package and add-on total`
  }
  return ` - ${money(P.totalDiscount)} (${P.totalDiscountPct}%); all applicable discounts have been applied across ${P.eligibleAddOnCount} eligible add-ons and ${P.otherDiscountsCount} other discounts`
}

// Discount summary lines (Output B52, from Backend DiscountHelper C20:C25).
// Every list here spans the OFFERED packages only.
function discountSummary(state, config, quote, offered) {
  const pk = quote.packages
  const disc = state.discounts || {}
  const lines = []
  const perPkg = (fn) => offered.map((p) => `${PACKAGE_LABELS[p]}, ${fn(p)}`).join('; ')

  const pdParts = offered.filter((p) => pk[p].perAddOnDiscount !== 0).map((p) => `${PACKAGE_LABELS[p]}, ${money(pk[p].perAddOnDiscount)}`)
  if (pdParts.length) lines.push(` - Package Discounts: ${pdParts.join('; ')}`)

  const lsParts = offered.filter((p) => pk[p].lateStart !== 0).map((p) => `${PACKAGE_LABELS[p]}, ${money(pk[p].lateStart)}`)
  if (lsParts.length) lines.push(` - Late-Start Discount: ${lsParts.join('; ')}`)

  // Read the calculator's own figures — never recompute. These are percentages
  // of subtotal-after-late-start, and they may have been trimmed by the stack
  // ceiling, so both the amount AND the labelled rate have to come from the
  // quote. Recomputing from `subtotal` (as this did until 2026-08-06, faithfully
  // porting the same bug from the sheet's Backend!B22:B24) overstated every
  // referral, sibling and custom line in any month with a late-start discount,
  // leaving the itemisation not summing to its own stated total.
  // Prints the rate only when every OFFERED tier delivers the same one, so a
  // "(5%)" heading can never sit above two different figures.
  //
  // In today's calculator that check always passes for these three fields, and
  // the guard is defence rather than an observed case: the trim in pricingCalc
  // spends addOnPct first, so the residual that reaches referral/sibling/custom
  // is (referral + sibling + custom − ceiling) — the per-package add-on term
  // cancels exactly, leaving a package-independent result. It is
  // perAddOnPctEffective that genuinely varies per tier, and rateLabel is never
  // called with it. Keep the guard: it costs nothing and it stops a future
  // change to the trim order from silently shipping a false rate.
  const rateLabel = (field) => {
    const vals = offered.map((p) => Math.round(pk[p][field] * 10) / 10)
    return vals.every((v) => v === vals[0]) ? ` (${vals[0]}%)` : ''
  }
  if (disc.referral) lines.push(` - Referral Discount${rateLabel('referralPctEffective')}: ${perPkg((p) => money(pk[p].referralDiscount))}`)
  if (disc.sibling) lines.push(` - Sibling Discount${rateLabel('siblingPctEffective')}: ${perPkg((p) => money(pk[p].siblingDiscount))}`)
  const custom = Math.max(0, Number(disc.custom) || 0)
  if (custom > 0) lines.push(` - Custom Discount${rateLabel('customPctEffective')}: ${perPkg((p) => money(pk[p].customDiscount))}`)

  if (offered.some((p) => pk[p].totalDiscount !== 0)) {
    lines.push(` - Total Discount: ${perPkg((p) => `${money(pk[p].totalDiscount)} (${pk[p].totalDiscountPct}%)`)}`)
  }
  return lines.join('\n')
}

// "What key services mean" — show a description only when its group is selected
// in an OFFERED package's service list (Backend ServiceHelper conditionals).
// Scanning all three would explain services the family cannot buy here.
function serviceDescriptions(state, ctx, offered) {
  const anySel = (...keys) =>
    offered.some((p) => keys.some((k) => {
      const v = state.services?.[p]?.[k]
      return typeof v === 'boolean' ? v : (Number(v) || 0) >= 1
    }))
  const groups = []
  if (anySel('competitions5', 'competitions10')) groups.push('competitions')
  if (anySel('internship')) groups.push('internship')
  if (anySel('soloProject')) groups.push('soloProject')
  if (anySel('groupProject')) groups.push('groupProject')
  if (anySel('groupSat')) groups.push('groupSat')
  if (anySel('satPopular', 'satPremium')) groups.push('oneOnOneSat')
  if (anySel('seniorAp5', 'seniorAp10', 'juniorAp5', 'juniorAp10')) groups.push('apTutoring')
  return groups.map((g) => ' - ' + C.serviceDescription(g, ctx)).join('\n')
}

export function buildEmail(state, config, refISO) {
  const dt = refNow(refISO)
  const monthName = dt.toFormat('LLLL')
  const monthBonus = C.MONTH_BONUS[monthName] || ''
  // A cleared or unparseable date must never reach a family. Luxon formats an
  // invalid DateTime as the literal string "Invalid DateTime", and the date
  // input in the builder is clearable, so both cases are reachable today.
  const expiryDT = state.discountExpires ? DateTime.fromISO(state.discountExpires, { zone: ZONE }) : null
  const expiry = expiryDT?.isValid ? expiryDT.toFormat('M/dd') : ''
  const quote = computeQuote(state, config, refISO)

  const grade = String(state.grade || '')
  const first = (state.firstName || '').trim()
  const last = (state.lastName || '').trim()
  const ctx = { first, last, grade, gender: state.gender }

  // The tiers Ryan is presenting, cheapest first. `top` is the most expensive
  // one offered — the tier the early-start bonus paragraph quotes, since that
  // bonus scales with the multiplier and VIP may not be on the table.
  const offered = normalizeSelectedPackages(state.selectedPackages)
  const top = offered[offered.length - 1]

  const blocks = []
  const h1 = (text) => blocks.push({ kind: 'h1', text })
  const h2 = (text) => blocks.push({ kind: 'h2', text })
  const p = (text) => blocks.push({ kind: 'p', text })
  const sp = () => blocks.push({ kind: 'spacer' })

  // Intro (B1)
  const n = offered.length
  h1(
    `Dear ${first} ${last} and family,\n\n` +
      `I hope you are doing well. Director Ryan asked me to share our updated proposal for ${first}. ` +
      `Below ${n === 1 ? 'is one' : `are ${C.countWord(n)}`} ${grade}th-grade option${n === 1 ? '' : 's'} ` +
      `at our best available pricing (discounts already applied), ` +
      `plus a ${monthBonus} discount that expires ${expiry}.`
  )
  sp()

  // Why now (B3-B4)
  h2(C.STATIC.whyNowHeading)
  {
    let why = C.WHY_NOW_BULLETS[grade] || ''
    // Three preconditions, each of which produced a wrong sentence when it was
    // not checked:
    //   • the window is open at all;
    //   • the top OFFERED tier actually earns a bonus — its multiplier may be
    //     0, and quoting "$0 in additional service" directly above a bonus
    //     block reading "No bonuses" is worse than saying nothing. bonusLines
    //     already gates on the same condition;
    //   • there is a real deadline to name, since the whole sentence is a
    //     dated promise.
    const earlyValue = quote.packages[top].earlyStartValue
    // The enrol-by date is the expiry Ryan sets on this proposal (Aaron,
    // 2026-08-10), and it may legitimately fall outside config.earlyStart's
    // apply window: that window governs when the bonus is CALCULATED, not what
    // Ryan is allowed to promise a family. Extending the deadline is his call
    // to make per proposal. Before this it was the literal date 4/27.
    if (quote.earlyStartApplies && earlyValue > 0 && expiryDT?.isValid) {
      // Same figure the bonus line prints, to the same precision. Rounding it
      // here to a whole number is what left "approximately 5 weeks" sitting
      // three paragraphs above "(4.9 weeks of additional service)".
      const w = quote.weeks
      why +=
        '\n\n' +
        C.earlyStartParagraph(ctx, {
          expiryText: expiry,
          durationText: `approximately ${w} week${w === 1 ? '' : 's'}`,
          topLabel: PACKAGE_LABELS[top],
          bonusText: money(earlyValue),
        })
    }
    p(why)
  }
  sp()

  // Bonus block (B6-B13)
  h2(`${monthBonus} Bonus: expires ${expiry}`)
  p(C.STATIC.bonusIntro)
  for (const pkg of offered) {
    blocks.push({ kind: 'h3', text: `Bonus for ${PACKAGE_LABELS[pkg]}:` })
    p(bonusLines(pkg, state, config, quote))
  }

  // Accomplish (B14-B15)
  const s1 = state.seasons?.[0]
  const s2 = state.seasons?.[1]
  h2(`What we typically accomplish during ${s1?.season || ''} and ${s2?.season || ''}`)
  {
    const a1 = C.SEASON_ACCOMPLISH[s1?.grade]?.[s1?.season] || ''
    const a2 = C.SEASON_ACCOMPLISH[s2?.grade]?.[s2?.season] || ''
    p([a1, a2].filter(Boolean).join('\n'))
  }
  sp()

  // The offered options (B17-48). Numbered by position, so a Comprehensive-only
  // proposal reads "Option 1", not "Option 2".
  for (const [i, pkg] of offered.entries()) {
    const P = quote.packages[pkg]
    h2(`Option ${i + 1}: ${grade}th ${PACKAGE_LABELS[pkg]} total after all discounts: ${money(P.total)}`)
    blocks.push({ kind: 'h3', text: `Included services for ${PACKAGE_LABELS[pkg]}:` })
    p(C.PACKAGE_INCLUDED[pkg])
    const addl = includedAddOns(pkg, quote)
    if (addl) p(addl)
    blocks.push({ kind: 'h3', text: `Bonus for ${PACKAGE_LABELS[pkg]}:` })
    p(bonusLines(pkg, state, config, quote))
    blocks.push({ kind: 'h3', text: `Discount for ${PACKAGE_LABELS[pkg]}:` })
    p(discountLine(pkg, quote))
    blocks.push({ kind: 'h3', text: 'Best for:' })
    p(C.bestFor(pkg, ctx))
    sp()
  }

  // Pricing confirmation (B50-52)
  h2(C.STATIC.pricingConfirmation)
  p(C.STATIC.discountsLead)
  p(discountSummary(state, config, quote, offered))
  sp()

  // Package details (B54-55)
  h2(C.STATIC.packageDetails)
  p(C.STATIC.packageDetailsBody)
  sp()

  // Custom plan (B57-59)
  h2(C.STATIC.customHeading)
  {
    const pr = C.pronouns(state.gender)
    p(`Starting this year, families can build their own plan. Choose only the services ${first} needs, and we will assemble an optimized plan around ${pr.poss} timeline and goals.`)
  }
  p(C.STATIC.customLink)
  sp()

  // Important note (B61-63)
  h2(C.STATIC.importantNote)
  {
    const pr = C.pronouns(state.gender)
    p(`While you are welcome to build a cheaper option if you wish, please know that our recommended packages (listed above) are best for ${first} in terms of increasing ${pr.poss} statistical chances of getting into better colleges. Removing services, specifically regarding projects and competitions, will take away the strategic enhancements we can make to differentiate ${pr.poss} profile.`)
  }
  p(C.STATIC.zoomOffer)
  sp()

  // Timeline (B65-70)
  h2(C.STATIC.timelineHeading)
  blocks.push({ kind: 'h3', text: C.STATIC.acHeading })
  p(C.academicCounseling(ctx))
  sp()
  blocks.push({ kind: 'h3', text: C.STATIC.caaHeading })
  p(C.STATIC.caaBody)
  sp()

  // What key services mean (B72-73)
  h2(C.STATIC.servicesHeading)
  p(serviceDescriptions(state, ctx, offered))
  sp()

  // Common questions (B75-83)
  h2(C.STATIC.commonQuestions)
  blocks.push({ kind: 'h3', text: C.STATIC.faqQ1 })
  p(C.STATIC.faqA1)
  blocks.push({ kind: 'h3', text: C.STATIC.faqQ2 })
  p(C.majorFaq(ctx))
  blocks.push({ kind: 'h3', text: `3. What if ${first}'s interests change?` })
  p(C.interestsFaq(ctx))
  blocks.push({ kind: 'h3', text: C.STATIC.faqQ4 })
  p(C.STATIC.faqA4)
  sp()

  // Payment options (B85-90)
  h2(C.STATIC.paymentOptions)
  blocks.push({ kind: 'h3', text: C.STATIC.paymentStep1 })
  for (const pkg of offered) p(`- ${PACKAGE_LABELS[pkg]} (${money(quote.packages[pkg].total)})`)
  p(C.STATIC.customReply)
  sp()

  // Payment terms (B92-96). The per-tier split rules are config now, so a
  // single-tier proposal still states its own terms; the defaults spread in
  // underneath so a config stored before this field renders unchanged.
  // Spread alone would let a null or "" written straight into the JSONB row
  // override the default and print "VIP ($25,935): null" to a family, so each
  // override has to survive a usability check rather than merely exist.
  const terms = { ...DEFAULT_PRICING.paymentTerms }
  for (const [pkg, v] of Object.entries(config.paymentTerms || {})) {
    if (typeof v === 'string' && v.trim()) terms[pkg] = v
  }
  h2(C.STATIC.paymentTerms)
  p(C.STATIC.paymentTermsBody)
  for (const pkg of offered) {
    p(`     - ${PACKAGE_LABELS[pkg]} (${money(quote.packages[pkg].total)}): ${terms[pkg]}`)
  }
  sp()

  // Pay-in-full incentive (B98-99) — named for the eligible tiers actually on
  // offer, and dropped entirely when none of them is eligible rather than
  // dangling an incentive against packages the family cannot buy here.
  const eligible = Array.isArray(config.payInFullPackages) ? config.payInFullPackages : DEFAULT_PRICING.payInFullPackages
  const payInFull = offered.filter((pkg) => eligible.includes(pkg))
  if (payInFull.length) {
    h2(C.payInFullHeading(payInFull.map((pkg) => PACKAGE_LABELS[pkg])))
    p(C.STATIC.payInFullBody)
    sp()
  }

  // Steps 2-5 (B101-111)
  blocks.push({ kind: 'h3', text: C.STATIC.step2Heading })
  p(C.STATIC.step2Body)
  sp()
  blocks.push({ kind: 'h3', text: C.STATIC.step3Heading })
  p(C.STATIC.step3Body)
  sp()
  blocks.push({ kind: 'h3', text: C.STATIC.step4Heading })
  p(C.STATIC.step4Body)
  sp()
  blocks.push({ kind: 'h3', text: C.STATIC.step5Heading })
  p(`Once DocuSign and payment are complete, we will promptly begin onboarding ${first}.`)
  sp()

  // For your reference (B113-118)
  h2(C.STATIC.forYourReference)
  p(C.STATIC.termsLabel)
  p(C.STATIC.termsLink)
  sp()
  p(C.STATIC.servicesListLabel)
  p(C.STATIC.servicesListLink)
  sp()

  // Closing (B120-123)
  p(C.STATIC.thanks)
  sp()
  p(C.STATIC.signOff)
  p(C.STATIC.signature)

  return { blocks, text: toText(blocks), html: toHtml(blocks) }
}

// Plain text: every block on its own line(s); spacer = blank line. Mirrors the
// Output column poured top-to-bottom.
export function toText(blocks) {
  return blocks.map((b) => (b.kind === 'spacer' ? '' : b.text)).join('\n')
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Rich HTML for clipboard paste into Gmail. Headings bold; line breaks → <br>.
export function toHtml(blocks) {
  const FONT = "font-family:'Figtree',Arial,sans-serif;"
  const body = blocks
    .map((b) => {
      if (b.kind === 'spacer') return '<div style="height:1em">&nbsp;</div>'
      const inner = esc(b.text).replace(/\n/g, '<br>')
      if (b.kind === 'h1') return `<div style="${FONT}font-size:15pt;font-weight:700;margin:0;padding:2px 0">${inner}</div>`
      if (b.kind === 'h2') return `<div style="${FONT}font-size:13pt;font-weight:700;margin:0;padding:2px 0">${inner}</div>`
      if (b.kind === 'h3') return `<div style="${FONT}font-weight:700;margin:0;padding:2px 0">${inner}</div>`
      return `<div style="${FONT}margin:0;padding:2px 0">${inner}</div>`
    })
    .join('')
  return `<div style="${FONT}">${body}</div>`
}
