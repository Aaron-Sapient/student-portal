// Turns lib/packageEmail.js's flat block stream (h2 / h3 / p / spacer, poured
// top-to-bottom the way the generator sheet's Output column was) back into the
// structure the copy already implies, so the page can lay it out instead of
// scrolling it.
//
// Nothing here rewrites, abridges or reorders a single character of Ryan's
// copy: every function below only GROUPS blocks and splits already-delimited
// lines. The proposal is a contractual document, so the text that reaches a
// family has to be byte-identical to what buildEmail produced.
//
// Section boundaries are matched against the exported constants in
// lib/packageContent.js, never against sniffed substrings, so a copy edit over
// there moves this in lockstep instead of silently dropping a section into the
// wrong bucket.

import * as C from '@/lib/packageContent'

const STEP_HEADINGS = new Set([
  C.STATIC.step2Heading,
  C.STATIC.step3Heading,
  C.STATIC.step4Heading,
  C.STATIC.step5Heading,
])

const CLOSING_LINES = new Set([C.STATIC.thanks, C.STATIC.signOff, C.STATIC.signature])

// "Option 1: 11th Comprehensive total after all discounts: $18,400"
export const OPTION_RE = /^Option\s+\d+:/

// Steps 2-5 and the sign-off are h3/p blocks with no h2 of their own, so in the
// email they fall under whichever heading happens to precede them (today
// "Pay-in-full incentive"). That is a structural accident of a linear document,
// not a claim about the copy, so they are lifted out here and given their own
// place on the page.
export function splitProposal(blocks) {
  const intro = []
  const sections = []
  let current = null

  for (const b of blocks) {
    if (b.kind === 'spacer') continue
    if (b.kind === 'h2') {
      current = { heading: b.text, items: [] }
      sections.push(current)
      continue
    }
    ;(current ? current.items : intro).push(b)
  }

  const steps = []
  const closing = []
  for (const section of sections) {
    const kept = []
    let step = null
    for (const b of section.items) {
      if (b.kind === 'h3' && STEP_HEADINGS.has(b.text)) {
        step = { heading: b.text, body: [] }
        steps.push(step)
        continue
      }
      // Checked before `step` so the sign-off never gets swallowed into step 5.
      if (b.kind === 'p' && CLOSING_LINES.has(b.text)) {
        closing.push(b.text)
        step = null
        continue
      }
      if (step) {
        step.body.push(b.text)
        continue
      }
      kept.push(b)
    }
    section.items = kept
  }

  return { intro, sections, steps, closing }
}

// Three sections get bespoke treatment; everything else renders as prose in the
// order buildEmail emitted it.
export function classifySections(sections) {
  const options = []
  const prose = []
  let bonus = null
  let payment = null

  for (const section of sections) {
    // Option sections carry a "Bonus for X:" heading too, so this test runs first.
    if (OPTION_RE.test(section.heading)) {
      options.push(section)
      continue
    }
    if (section.heading === C.STATIC.paymentOptions) {
      payment = section
      continue
    }
    if (!bonus && section.items.some((b) => b.kind === 'h3' && /^Bonus for /.test(b.text))) {
      // The standalone bonus block repeats, verbatim, the per-tier bonus lines
      // that also appear inside each Option. On a page they can be shown once:
      // the lists live on the tier cards (where the choice is made) and only the
      // lead sentence is kept here.
      bonus = section
      continue
    }
    prose.push(section)
  }

  return { options, prose, bonus, payment }
}

// One tier card's parts, keyed off the h3s inside its Option section. The
// add-on list has no h3 of its own in the email — it is simply the second
// paragraph under "Included services for X:" — so position is what separates it.
export function tierParts(section) {
  const parts = { included: '', addOns: '', bonus: '', discount: '', bestFor: '' }
  let key = null
  let includedSeen = 0

  for (const b of section.items) {
    if (b.kind === 'h3') {
      if (/^Included services/.test(b.text)) key = 'included'
      else if (/^Bonus for/.test(b.text)) key = 'bonus'
      else if (/^Discount for/.test(b.text)) key = 'discount'
      else if (/^Best for/.test(b.text)) key = 'bestFor'
      else key = null
      continue
    }
    if (b.kind !== 'p' || !key) continue
    if (key === 'included') {
      if (includedSeen === 0) parts.included = b.text
      else parts.addOns = parts.addOns ? `${parts.addOns}\n${b.text}` : b.text
      includedSeen += 1
      continue
    }
    parts[key] = parts[key] ? `${parts[key]}\n${b.text}` : b.text
  }

  return parts
}

// A block's text into paragraphs and lists. The generator already marks every
// list line with a leading "- ", so this is a split, not a reinterpretation.
export function parseText(text) {
  const nodes = []
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue
    const bullet = raw.match(/^\s*-\s+(.*)$/)
    if (bullet) {
      const last = nodes[nodes.length - 1]
      if (last && last.type === 'ul') last.items.push(bullet[1].trim())
      else nodes.push({ type: 'ul', items: [bullet[1].trim()] })
      continue
    }
    nodes.push({ type: 'p', text: raw.trim() })
  }
  return nodes
}

// A whole section's items, with adjacent single-line bullet paragraphs merged
// into one list. Payment terms and the Step 1 reply options each emit one block
// PER TIER, which without this would render as three one-item lists.
export function sectionNodes(items) {
  const nodes = []
  for (const b of items) {
    if (b.kind === 'h3') {
      nodes.push({ type: 'h3', text: b.text })
      continue
    }
    for (const node of parseText(b.text)) {
      const last = nodes[nodes.length - 1]
      if (node.type === 'ul' && last && last.type === 'ul') last.items.push(...node.items)
      else nodes.push(node)
    }
  }
  return nodes
}

// " - Families who want..." → "Families who want...". Used where a one-line
// block is shown as a sentence rather than as a list of one.
export function stripBullet(text) {
  return String(text || '').replace(/^\s*-\s+/, '').trim()
}

// The bonus block's last line is its own total ("Total value: $X" or "No
// bonuses"), which the card promotes out of the list into a figure.
export function splitBonus(text) {
  const items = parseText(text).flatMap((n) => (n.type === 'ul' ? n.items : [n.text]))
  const last = items[items.length - 1] || ''
  if (/^Total value:/.test(last) || /^No bonuses$/.test(last)) {
    return { items: items.slice(0, -1), total: last }
  }
  return { items, total: '' }
}

// "Meetings: Biweekly 1 to 1" → { label, value }. The three tiers list the same
// eleven labels in the same order, which is what lets the cards read across as
// a comparison table without being one.
export function labelValue(line) {
  const at = line.indexOf(': ')
  if (at === -1) return { label: '', value: line }
  return { label: line.slice(0, at), value: line.slice(at + 2) }
}

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}
