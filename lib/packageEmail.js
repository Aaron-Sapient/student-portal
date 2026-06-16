// Assembles the proposal email from the calculator (lib/pricingCalc) + the
// verbatim copy (lib/packageContent), mirroring the auto-generator sheet's
// Output tab block-for-block. Returns ordered blocks plus rendered plain-text
// and rich-HTML (for clipboard paste into Gmail). Client-safe.
//
// Two sheet bugs are intentionally NOT reproduced (cleaner client email):
//   • a stray "FALSE" line in the discount summary (an empty IF with no else);
//   • baked-in wrong-gender pronouns / "{name}gets" spacing in the early-start
//     paragraph (now gender- and grade-correct, handled in lib/packageContent).

import { DateTime } from 'luxon'
import { PACKAGES, PACKAGE_LABELS } from './pricingSchema'
import { computeQuote, money } from './pricingCalc'
import * as C from './packageContent'

const ZONE = 'America/Los_Angeles'

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
  return ` - ${money(P.totalDiscount)} (${P.totalDiscountPct}%); all applicable discounts have been applied across ${P.eligibleAddOnCount} eligible add-ons and ${P.otherDiscountsCount} other discounts`
}

// Discount summary lines (Output B52, from Backend DiscountHelper C20:C25).
function discountSummary(state, config, quote) {
  const pk = quote.packages
  const disc = state.discounts || {}
  const lines = []
  const triplet = (fn) => PACKAGES.map((p) => `${PACKAGE_LABELS[p]}, ${fn(p)}`).join('; ')

  const pdParts = PACKAGES.filter((p) => pk[p].perAddOnDiscount !== 0).map((p) => `${PACKAGE_LABELS[p]}, ${money(pk[p].perAddOnDiscount)}`)
  if (pdParts.length) lines.push(` - Package Discounts: ${pdParts.join('; ')}`)

  const lsParts = PACKAGES.filter((p) => pk[p].lateStart !== 0).map((p) => `${PACKAGE_LABELS[p]}, ${money(pk[p].lateStart)}`)
  if (lsParts.length) lines.push(` - Late-Start Discount: ${lsParts.join('; ')}`)

  if (disc.referral) lines.push(` - Referral Discount (${config.discounts.referralPct}%): ${triplet((p) => money((config.discounts.referralPct / 100) * pk[p].subtotal))}`)
  if (disc.sibling) lines.push(` - Sibling Discount (${config.discounts.siblingPct}%): ${triplet((p) => money((config.discounts.siblingPct / 100) * pk[p].subtotal))}`)
  const custom = Math.max(0, Number(disc.custom) || 0)
  if (custom > 0) lines.push(` - Custom Discount (${Math.round(custom * 100)}%): ${triplet((p) => money(custom * pk[p].subtotal))}`)

  if (PACKAGES.some((p) => pk[p].totalDiscount !== 0)) {
    lines.push(` - Total Discount: ${triplet((p) => `${money(pk[p].totalDiscount)} (${pk[p].totalDiscountPct}%)`)}`)
  }
  return lines.join('\n')
}

// "What key services mean" — show a description only when its group is selected
// in any package's service list (Backend ServiceHelper conditionals).
function serviceDescriptions(state, ctx) {
  const anySel = (...keys) =>
    PACKAGES.some((p) => keys.some((k) => {
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
  const expiry = state.discountExpires
    ? DateTime.fromISO(state.discountExpires, { zone: ZONE }).toFormat('M/dd')
    : ''
  const quote = computeQuote(state, config, refISO)

  const grade = String(state.grade || '')
  const first = (state.firstName || '').trim()
  const last = (state.lastName || '').trim()
  const ctx = { first, last, grade, gender: state.gender }

  const blocks = []
  const h1 = (text) => blocks.push({ kind: 'h1', text })
  const h2 = (text) => blocks.push({ kind: 'h2', text })
  const p = (text) => blocks.push({ kind: 'p', text })
  const sp = () => blocks.push({ kind: 'spacer' })

  // Intro (B1)
  h1(
    `Dear ${first} ${last} and family,\n\n` +
      `I hope you are doing well. Director Ryan asked me to share our updated proposal for ${first}. ` +
      `Below are three ${grade}th-grade options at our best available pricing (discounts already applied), ` +
      `plus a ${monthBonus} discount that expires ${expiry}.`
  )
  sp()

  // Why now (B3-B4)
  h2(C.STATIC.whyNowHeading)
  {
    let why = C.WHY_NOW_BULLETS[grade] || ''
    if (quote.earlyStartApplies) {
      why += '\n\n' + C.earlyStartParagraph(ctx, money(quote.packages.vip.earlyStartValue))
    }
    p(why)
  }
  sp()

  // Bonus block (B6-B13)
  h2(`${monthBonus} Bonus: expires ${expiry}`)
  p(C.STATIC.bonusIntro)
  for (const pkg of PACKAGES) {
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

  // Three options (B17-48)
  const optionLabels = { essential: 'Option 1', comprehensive: 'Option 2', vip: 'Option 3' }
  for (const pkg of PACKAGES) {
    const P = quote.packages[pkg]
    h2(`${optionLabels[pkg]}: ${grade}th ${PACKAGE_LABELS[pkg]} total after all discounts: ${money(P.total)}`)
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
  p(discountSummary(state, config, quote))
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
  p(serviceDescriptions(state, ctx))
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
  p(`- Essential (${money(quote.packages.essential.total)})`)
  p(`- Comprehensive (${money(quote.packages.comprehensive.total)})`)
  p(`- VIP (${money(quote.packages.vip.total)})`)
  p(C.STATIC.customReply)
  sp()

  // Payment terms (B92-96)
  h2(C.STATIC.paymentTerms)
  p(C.STATIC.paymentTermsBody)
  p(`     - Essential (${money(quote.packages.essential.total)}): typically due in full upon enrollment.`)
  p(`     - Comprehensive (${money(quote.packages.comprehensive.total)}): may be split into 2 payments, 30 days apart. The full balance must be paid within 30 days of enrollment.`)
  p(`     - VIP (${money(quote.packages.vip.total)}): may be split into 3 payments, each 30 days apart. The full balance must be paid within 60 days of enrollment.`)
  sp()

  // Pay-in-full incentive (B98-99)
  h2(C.STATIC.payInFullHeading)
  p(C.STATIC.payInFullBody)
  sp()

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
