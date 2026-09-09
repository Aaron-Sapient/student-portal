import { PACKAGE_INCLUDED } from '@/lib/packageContent';

/* THE OFFER RYAN ACTUALLY MADE, on the page (2026-09-08, Aaron: "each heavy
   /lead link should always generate the full custom package proposal off-rip,
   including the add-ons").
   ─────────────────────────────────────────────────────────────────────────
   WHY THIS REPLACES THE BASE LADDER RATHER THAN JOINING IT. A heavy page used
   to print the base card for the student's grade while the heavy EMAIL carried
   Ryan's configured quote, and those are different numbers: Neha's page said
   $16,500 for VIP while her email said $41,650. A family holding both reads a
   contradiction. So a row that has a quote shows the quote, and the ladder's
   figures come off (page.js suppresses them); the price-free catalogue stays
   below as the "everything we do" reference.

   NOTHING HERE IS COMPUTED. Every figure comes from buildContract(), which
   re-derives from the quote's OWN frozen config_snapshot, so this page cannot
   drift from the email even when the pricing dashboard moves. Verified
   2026-09-08 against all four sent proposals: the totals, the add-on lines and
   the bonus lines match to the dollar.

   IT LOOKS HAND-TUNED BECAUSE IT IS. Rishaan's quote offers Comprehensive
   alone; the other three offer two tiers. That comes out of the DATA (the
   contract's `offered` array), so no row is special-cased and no family is ever
   shown a tier Ryan did not extend to them. */

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/* QUANTIFY's `unit` strings were written for a contract payload, where a
   deliverable is a row in a record ("extra colleges"). On the page they are
   labels a parent reads beside a figure, and the sent email title-cases them.
   Only the first letter is raised: anything more would be inventing labels,
   and "group SAT courses" must keep its own capitals. */
const label = (u) => (u ? u.charAt(0).toUpperCase() + u.slice(1) : u);

/* The tier's standing inclusions, as the generator writes them into the email:
   a newline-delimited " - Label: Value" block. Split rather than re-authored,
   so the page and the email say the same words as well as the same numbers. */
function includedLines(pkg) {
  return (PACKAGE_INCLUDED[pkg] || '')
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

export default function Proposal({ contract, firstName }) {
  const tiers = contract.offered.map((k) => [k, contract.tiers[k]]).filter(([, t]) => t);
  if (tiers.length === 0) return null;

  return (
    <div className="proposal">
      {/* ONE option is a statement and gets a single column; two are peers and
          get two. Same rule the ladder uses, for the same reason: one card
          stranded in a two-column grid reads as an option that failed to load. */}
      <div className={tiers.length === 1 ? 'grid gap-5 lg:max-w-[30rem]' : 'grid gap-5 lg:grid-cols-2 lg:gap-4'}>
        {tiers.map(([key, t]) => (
          <div key={key} className="neu-raised flex flex-col rounded-[1.75rem] p-6">
            <p className="font-display text-[1.25rem] font-semibold leading-snug text-ink">
              {t.label}
            </p>
            <p className="mt-2 font-display text-[2rem] font-normal leading-none text-ink">
              {money(t.total)}
            </p>
            <p className="mt-1 text-[13px] leading-snug text-ink-faint">
              Total for {firstName}, after every discount.
            </p>

            <p className="proposal-h mt-6">What the package includes</p>
            <ul className="ticks mt-3 space-y-2 text-[15px] leading-relaxed text-ink-soft">
              {includedLines(key).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>

            {t.deliverables.length > 0 && (
              <>
                <p className="proposal-h mt-6">Added for {firstName}</p>
                <ul className="mt-3 space-y-2 text-[15px] leading-relaxed text-ink-soft">
                  {t.deliverables.map((d) => (
                    <li key={d.key} className="proposal-line">
                      <span>
                        {label(d.unit)}
                        {d.qty ? ` (${d.qty})` : ''}
                      </span>
                      <span className="proposal-amount">{money(d.value)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* A BONUS IS NOT A CHARGE and must never read as one. The value is
                shown because it is the point (it says what the family is being
                given), and the words carry the difference the column cannot. */}
            {t.bonuses.length > 0 && (
              <>
                <p className="proposal-h mt-6">Included at no charge</p>
                <ul className="mt-3 space-y-2 text-[15px] leading-relaxed text-ink-soft">
                  {t.bonuses.map((b) => (
                    <li key={b.key} className="proposal-line">
                      <span>
                        {label(b.unit)}
                        {b.qty ? ` (${b.qty})` : ''}
                      </span>
                      <span className="proposal-amount proposal-bonus">
                        {money(b.value)} value
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* THE WORKING, not just the answer. A parent who sees a total
                asserted wonders how it was reached; a parent who can follow
                base, add-ons and the discount down to the total does not have
                to ask. This is also the honest place for the discount to live:
                it is a real reduction off a real subtotal, not a headline. */}
            <dl className="proposal-sum mt-6">
              <div>
                <dt>Package</dt>
                <dd>{money(t.base)}</dd>
              </div>
              {t.addOnTotal > 0 && (
                <div>
                  <dt>Added services</dt>
                  <dd>{money(t.addOnTotal)}</dd>
                </div>
              )}
              {/* THE DISCOUNT SHOWN IS SUBTOTAL MINUS TOTAL, never the engine's
                  own `totalDiscount` (2026-09-08). A stacked percentage lands on
                  a half dollar often enough to matter: Neha's Comprehensive is
                  15% of $31,750, which is $4,762.50. The engine rounds the TOTAL
                  to $26,988 while the discount rounds to $4,763, and a column
                  printing both foots to $26,987 against a stated $26,988. A
                  parent who checks the arithmetic on the most expensive thing
                  they will buy this year must find that it adds up, so the one
                  figure that is derived rather than displayed is the one nobody
                  is quoted: the difference. Two of the six live tier cards were
                  wrong this way before this line existed. */}
              {t.subtotal - t.total > 0 && (
                <div>
                  <dt>Discount ({t.totalDiscountPct}%)</dt>
                  <dd>-{money(t.subtotal - t.total)}</dd>
                </div>
              )}
              <div className="proposal-total">
                <dt>Total</dt>
                <dd>{money(t.total)}</dd>
              </div>
            </dl>

            {t.paymentTerms && (
              <p className="mt-4 text-[13px] leading-relaxed text-ink-faint">
                This total {t.paymentTerms}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
