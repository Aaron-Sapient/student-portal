// One FIGURE per service: the service is the unit, the offered tiers are rows
// inside it, and each row carries its tier MARK (E / C / V) followed by the
// answer.
//
// What the answer looks like is decided per service by one test: would a
// person read it faster as a picture than as the sentence? A cadence is faster
// as a month with the meetings drawn on it. A count is faster as that many
// glyphs. Included-or-not is faster as the glyph being there or not. Everything
// else — "Full academic and testing plan" — is a fixed value whose sentence IS
// the fastest read, so it stays a sentence. No row is ever a diff: every tier
// states its own value, every time.
//
// Provenance is unchanged from serviceCatalog.js: every caption is the email's
// own line; the pictures are derived from those lines by the small parsers
// below, and a line that no parser recognises falls back to its words.

import { PACKAGE_LABELS } from '@/lib/pricingSchema'

// Tier mark: fixed per package, not per position among the offered tiers, so a
// two-tier proposal still shows Comprehensive as C — the family may have seen
// the three-tier version elsewhere and the marks must mean the same thing.
export const TIER_DOTS = { essential: 1, comprehensive: 2, vip: 3 }

/* ── parsers ────────────────────────────────────────────────────────────── */

// "Monthly 1 to 1" → weeks [1]; "Biweekly …" → [1,3]; "Weekly …" → [1,2,3,4].
// Returns null when the line names no cadence, so the row falls back to words.
function cadenceWeeks(text) {
  const t = String(text || '').toLowerCase()
  if (/\bbi-?weekly\b/.test(t)) return [1, 3]
  if (/\bweekly\b/.test(t)) return [1, 2, 3, 4]
  if (/\bmonthly\b/.test(t)) return [1]
  return null
}

// "5, included" → 5 · "10, free bonus" → 10 · "Included" → 1 · "Not offered" → 0
function countOf(cell) {
  if (cell.tone === 'off') return 0
  const m = String(cell.text).match(/^(\d+)/)
  return m ? Number(m[1]) : 1
}

/* ── figure kinds, keyed by slug ────────────────────────────────────────── */
// cadence  — a four-week strip, meetings drawn as filled weeks
// count    — n unit glyphs (perPackageCount / count add-ons)
// presence — the glyph is there or it is not (flat add-ons, Waitlist & Appeals)
// words    — the line itself (qualitative depth); default for anything unlisted
const KIND = {
  meetings: 'cadence',
  'monitoring-accountability': 'cadence',
  'waitlist-appeals': 'presence',
  'extra-college': 'count',
  'competitions-5': 'presence',
  'competitions-10': 'presence',
  internship: 'count',
  'solo-project': 'count',
  'group-project': 'count',
  'group-sat': 'count',
  'sat-popular': 'presence',
  'sat-premium': 'presence',
  'senior-ap-5': 'presence',
  'senior-ap-10': 'presence',
  'junior-ap-5': 'presence',
  'junior-ap-10': 'presence',
}

export function figureKind(row) {
  return KIND[row.slug] || 'words'
}

/* ── the marks ──────────────────────────────────────────────────────────── */

export const TIER_LETTER = { essential: 'E', comprehensive: 'C', vip: 'V' }
export function TierMark({ pkg }) {
  // E / C / V — the shorthand the family already knows from the call. (The
  // earlier ●/●●/●●● took the AirPods analogy literally; a letter is legible
  // without a legend and does not need counting.)
  return (
    <span className="pp-mark-dots pp-mark-letter" aria-hidden="true">
      {TIER_LETTER[pkg] || 'E'}
    </span>
  )
}

/* ── the pictures ───────────────────────────────────────────────────────── */

function Cadence({ cell }) {
  const weeks = cadenceWeeks(cell.text)
  if (!weeks) return <Words cell={cell} />
  // The remainder of the line after the cadence word ("1 to 1", "w/ task
  // tracking") is the part the picture cannot draw, so it is the caption.
  // "accountability" is the service's own name repeated on every line; the
  // heading already says it, so the caption keeps only what follows it.
  const rest = String(cell.text)
    .replace(/^\s*(bi-?weekly|weekly|monthly)\s*/i, '')
    .replace(/^accountability\s*/i, '')
    .trim()
  return (
    <>
      <span className="pp-month" role="img" aria-label={cell.text}>
        {[1, 2, 3, 4].map((w) => (
          <i key={w} data-on={weeks.includes(w) ? '1' : undefined} />
        ))}
      </span>
      <span className="pp-cap">
        {cell.text.split(/\s+/)[0]}
        {rest ? <span className="pp-cap-2"> · {rest}</span> : null}
      </span>
    </>
  )
}

function Count({ cell, glyph }) {
  // The numeral is the figure. Rows of unit glyphs stop being countable past
  // four (subitizing), so "10" was already carrying the value; the glyphs were
  // texture. One glyph keeps the service's icon on the row.
  const n = countOf(cell)
  if (!n) return <Words cell={cell} />
  return (
    <>
      <span className="pp-units" role="img" aria-label={cell.text} data-tone={cell.tone}>
        <span className="pp-unit">{glyph}</span>
        <span className="pp-num">{n}</span>
      </span>
      <span className="pp-cap" data-tone={cell.tone}>
        {cell.tone === 'bonus' ? <span className="pp-cap-2">free bonus</span> : null}
      </span>
    </>
  )
}

function Presence({ cell, glyph }) {
  const on = cell.tone !== 'off'
  return (
    <>
      <span className="pp-units" role="img" aria-label={cell.text} data-tone={cell.tone}>
        <span className={on ? 'pp-unit' : 'pp-unit pp-unit--off'}>{glyph}</span>
      </span>
      <span className="pp-cap" data-tone={cell.tone}>
        {cell.text}
      </span>
    </>
  )
}

function Words({ cell }) {
  return (
    <span className="pp-cap pp-cap--words" data-tone={cell.tone}>
      {cell.text}
    </span>
  )
}

/* ── one figure ─────────────────────────────────────────────────────────── */

export function Figure({ row, glyph }) {
  const kind = figureKind(row)
  return (
    <div className="pp-fig" data-kind={kind} data-slug={row.slug}>
      <h3 className="pp-fig-name">
        <span className="pp-fig-glyph" aria-hidden="true">
          {glyph}
        </span>
        {row.label}
        {row.kind === 'addon' && <span className="pp-tag">add-on</span>}
      </h3>
      <ul className="pp-fig-rows">
        {row.cells.map((cell) => (
          <li key={cell.pkg} className="pp-fig-row" data-pkg={cell.pkg} data-tone={cell.tone}>
            <TierMark pkg={cell.pkg} />
            <span className="pp-sr">{PACKAGE_LABELS[cell.pkg]}: </span>
            <span className="pp-fig-val">
              {kind === 'cadence' ? (
                <Cadence cell={cell} />
              ) : kind === 'count' ? (
                <Count cell={cell} glyph={glyph} />
              ) : kind === 'presence' ? (
                <Presence cell={cell} glyph={glyph} />
              ) : (
                <Words cell={cell} />
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
