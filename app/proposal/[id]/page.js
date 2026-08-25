import { cache } from 'react';
import { notFound } from 'next/navigation';
import { DateTime } from 'luxon';

import { getQuote } from '@/lib/pricing';
import { mergeConfig, normalizeSelectedPackages, PACKAGE_LABELS } from '@/lib/pricingSchema';
import { computeQuote, money } from '@/lib/pricingCalc';
import { buildEmail } from '@/lib/packageEmail';
import * as C from '@/lib/packageContent';
import { sectionNodes, slugify, splitProposal } from './proposalSections';
import { buildCatalog, SERVICE_ICONS } from './serviceCatalog';
import { Figure, TierMark } from './figures';

// The proposal a family opens, behind the same capability URL the /write word
// processor uses: possession of the unguessable quote uuid IS the auth, so
// there is no account to make and nothing to sign into. It replaces a 1,700-word
// email plus PDF attachments.
//
// THE SHAPE OF THE PAGE. The data is a matrix (services × tiers) and the page
// refuses to be one. Each SERVICE is a figure; the offered tiers are rows
// inside it, marked ● / ●● / ●●● (the AirPods quick-start encoding), and the
// row's answer is whatever a person reads fastest for THAT service: a month
// with the meetings drawn on it, five little glyphs for five colleges, a glyph
// present or absent for included-or-not, and otherwise the line itself. No
// tier columns, no dropdowns, no diffs — every tier states its own value.
// (Rewritten 2026-08-24 from the tier-column layout after Aaron's review:
// price was the loudest thing, the picker had thirty options, and the columns
// were the schema wearing a nicer font.)
//
// Price comes LAST. One total per tier under the figures, the largest type on
// the page, with the single Choose control beneath — the closing line of the
// argument the figures make. The accent is spent only on Choose, on links, and
// on the tier the family has tapped in the legend.
//
// Every number and every sentence still comes from buildEmail, the same builder
// that produced the email. The comparison is a LENS on that copy (each answer is
// a substring of the email's own line); the letter below it is the DOCUMENT, in
// buildEmail's own order, with nothing abridged — including the per-tier option
// blocks, which are where the add-on prices and bonus values live. A proposal
// that abridges its own terms is a different document.

export const dynamic = 'force-dynamic';

const ZONE = 'America/Los_Angeles';

// package_quotes.id is a uuid (scripts/supabase-pricing-schema.sql). Postgres
// raises on a malformed one, so shape-check before asking — a typo'd link is a
// 404, never a 500. Same constant as the admin read route beside it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIRM = {
  phone: '(949) 910-5366',
  tel: '+19499105366',
  email: 'support@admissions.partners',
};

// generateMetadata and the page body both need the row; cache() collapses that
// into one Supabase read per request.
const loadQuote = cache(async (id) => (UUID_RE.test(String(id || '')) ? getQuote(id) : null));

// The config the proposal was PRICED against, and nothing else. A quote saved
// before the config_snapshot column existed has none — and falling back to
// today's pricing dashboard would render a CONTRACT whose numbers no longer
// match what the family was quoted, silently, with the same confident layout.
// A page that cannot prove its own totals must not be served (see the notFound
// below); Ryan can re-save that proposal from the builder, which snapshots.

function studentNames(quote) {
  const sel = quote?.selection || {};
  const first = String(sel.firstName || '').trim();
  const last = String(sel.lastName || '').trim();
  const full = `${first} ${last}`.trim() || String(quote?.student_name || '').trim();
  return { first, last, full };
}

export async function generateMetadata({ params }) {
  const { id } = await params;
  const quote = await loadQuote(id);
  const { full } = studentNames(quote);
  return {
    title: `${full || 'Proposal'} · Admissions Partners proposal`,
    robots: { index: false, follow: false, nocache: true },
  };
}

/* ── text rendering ──────────────────────────────────────────────────────── */

// Bare URLs in the copy (package details, terms, services list) become real
// links. The anchor text stays the URL, so a printed page loses nothing.
function Linked({ text }) {
  const parts = String(text).split(/(https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} className="pp-link" target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function Nodes({ nodes }) {
  return (
    <>
      {nodes.map((node, i) => {
        if (node.type === 'h3') {
          return (
            <h3 key={i} className="pp-h3">
              {node.text}
            </h3>
          );
        }
        if (node.type === 'ul') {
          return (
            <ul key={i} className="pp-list">
              {node.items.map((item, j) => (
                <li key={j}>
                  <Linked text={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            <Linked text={node.text} />
          </p>
        );
      })}
    </>
  );
}

// The service glyph. Vendored Lucide paths live in ./serviceCatalog.js; a slug
// with no entry renders nothing rather than a nearest-neighbour glyph that
// would claim the wrong idea.
function ServiceIcon({ slug }) {
  const nodes = SERVICE_ICONS[slug];
  if (!nodes) return null;
  return (
    <svg
      className="pp-svc-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {nodes}
    </svg>
  );
}

/* ── the decision ────────────────────────────────────────────────────────── */

function chooseHref(first, label) {
  const subject = `${first || 'Our student'} - we choose ${label}`;
  const body = `We would like to move forward with the ${label} option for ${first || 'our student'}.`;
  return `mailto:${FIRM.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// The email's own "Or reply Custom" path, kept as a real control. It sits in the
// footer rather than beside the totals: it is a fourth answer to a three-answer
// question, and next to the three Choose controls it competed with them for the
// same decision. At the end of the document it is where someone who has read
// everything and wants something else is already looking.
function customHref(first) {
  const subject = `${first || 'Our student'} - we would like a custom plan`;
  return `mailto:${FIRM.email}?subject=${encodeURIComponent(subject)}`;
}

/* ── the one piece of client JS ──────────────────────────────────────────────
   The tier pick. Tapping a tier in the legend (or hovering a total) sets
   data-pick on the comparison root; CSS then lights that tier's marks in every
   figure and its total at the end, so the consequence of "what if we went
   Comprehensive" is visible across the whole page at once. Presentation only:
   nothing is selected, nothing is routed, and with JS off every row simply
   stands at equal weight. Delegated on document so it is registered before the
   markup exists. */
const PICK_JS = `(function(){
var d=document;d.documentElement.setAttribute('data-pp-js','1');
d.addEventListener('click',function(ev){
 var t=ev.target&&ev.target.closest?ev.target.closest('[data-pick-tier]'):null;if(!t)return;
 var root=t.closest('[data-compare]');if(!root)return;
 var pkg=t.getAttribute('data-pick-tier'),was=root.getAttribute('data-pick');
 root.setAttribute('data-pick',was===pkg?'':pkg);
 var bs=root.querySelectorAll('[data-pick-tier]');
 for(var i=0;i<bs.length;i++)bs[i].setAttribute('aria-pressed',String(was!==pkg&&bs[i].getAttribute('data-pick-tier')===pkg));
});
})();`;

/* ── page ────────────────────────────────────────────────────────────────── */

export default async function ProposalPage({ params, searchParams }) {
  const { id } = await params;
  const quote = await loadQuote(id);
  // A row with no `selection` cannot be re-rendered as a page (only the Saved
  // tab's stored email_html could show it), so there is nothing to serve here.
  // A row with no `config_snapshot` is refused for the reason above it: the
  // page would render today's prices under a date the family was quoted at.
  if (!quote || !quote.selection || !quote.config_snapshot) notFound();

  const selection = quote.selection;
  const config = mergeConfig(quote.config_snapshot);
  // The date this proposal was last WRITTEN, not first created. updateQuote
  // overwrites selection + email_html + config_snapshot and leaves created_at
  // alone, so an edited quote re-rendered against created_at resolves the
  // season, the late-start window and the early-start block to the wrong month
  // and every total on the page drifts away from the email that was sent. Same
  // value feeds the "Prepared" line, so the date shown is the date priced.
  const refISO = quote.updated_at || quote.created_at || null;

  const { blocks } = buildEmail(selection, config, refISO);
  const quoteTotals = computeQuote(selection, config, refISO);
  const offered = normalizeSelectedPackages(selection.selectedPackages);

  // No classifySections here on purpose. That helper exists to pull three
  // sections out for bespoke treatment; this page gives bespoke treatment to
  // NO section — the comparison is built from the catalog, and the letter
  // renders every section buildEmail emitted, in its original order.
  const { sections, steps, closing } = splitProposal(blocks);

  const { first, last } = studentNames(quote);
  const grade = String(selection.grade || '');

  const preparedDT = refISO ? DateTime.fromISO(refISO, { zone: ZONE }) : null;
  const prepared = preparedDT?.isValid ? preparedDT.toFormat('LLLL d, yyyy') : '';
  // A bare "yyyy-MM-dd" carries no zone; parsed the same way buildEmail parses
  // it, so the page and the email can never name two different deadlines.
  const expiryDT = selection.discountExpires
    ? DateTime.fromISO(selection.discountExpires, { zone: ZONE })
    : null;
  const expiry = expiryDT?.isValid ? expiryDT.toFormat('LLLL d, yyyy') : '';
  // The deadline is a CALENDAR DAY, so it runs to the end of that day in the
  // firm's zone: a family opening the link on the expiry date itself is inside
  // the offer, not outside it. Without this the page kept presenting a dead
  // price as a live one, with working Choose buttons under it.
  const expired = !!expiryDT?.isValid && DateTime.now().setZone(ZONE) > expiryDT.endOf('day');
  // A provisioned quote is a family who already enrolled: the receipt on the
  // row is what they accepted, so the page stops offering a choice.
  const enrolled = !!quote.provisioned_at;
  const live = !expired && !enrolled;
  const monthBonus = preparedDT?.isValid ? C.MONTH_BONUS[preparedDT.toFormat('LLLL')] || '' : '';

  /* ── the opener ───────────────────────────────────────────────────────────
     ONE sentence, and it is the page's own, not the email's. The letter opens
     "I hope you are doing well. Director Ryan asked me to share our proposal
     for X. Below are three 11th-grade options at our best available pricing" —
     a covering note written for an inbox, where the reader has to be told what
     the attachment is. On a page the reader is already looking at the three
     options, so that paragraph spends the most valuable line on the surface
     explaining the surface. What a family cannot see by looking is the two
     facts this sentence carries instead: these were built for their child, and
     they stand until a date. Everything else the paragraph said is still on the
     page verbatim, in the letter below, in buildEmail's own order. */
  const n = offered.length;
  const optionsPhrase = `${C.countWord(n)} option${n === 1 ? '' : 's'}`;
  const bonusClause = monthBonus ? ` It includes the ${monthBonus} bonus.` : '';
  const openerLead = `${optionsPhrase.charAt(0).toUpperCase()}${optionsPhrase.slice(1)} built around ${first || 'your student'}, at our best available pricing with discounts applied`;
  const opener = `${openerLead}${expiry ? `, valid through ${expiry}` : ''}.${bonusClause}`;

  const catalog = buildCatalog(selection, offered);
  const offeredAddons = catalog.filter((r) => r.kind === 'addon' && r.offeredSomewhere);
  const otherAddons = catalog.filter((r) => r.kind === 'addon' && !r.offeredSomewhere);
  const baseRows = catalog.filter((r) => r.kind === 'base');

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: PICK_JS }} />

      <main className="pp-page">
        {/* Who this is for, and how long it stands. No instructions and no
            decoration — the reader knows how to read a document. */}
        <header>
          <p className="pp-mark">
            Admissions <i>|</i> Partners
          </p>
          <h1 className="pp-title">Prepared for the {last || 'family'} family</h1>
          <p className="pp-meta">
            {[first, grade && `${grade}th grade`, prepared && `Prepared ${prepared}`]
              .filter(Boolean)
              .join(' · ')}
          </p>

          {/* Live, the opener carries the validity date, so the pill would say
              it twice. Expired and enrolled are a different claim — that the
              numbers below are not an offer any more — and that one keeps its
              own line, with both ways to reach the firm in it. */}
          {enrolled ? (
            <p className="pp-status">
              <b>You are enrolled.</b> This is the proposal you accepted, kept here for reference.
            </p>
          ) : expired ? (
            <p className="pp-status">
              <b>This pricing expired on {expiry}.</b> Call{' '}
              <a className="pp-link" href={`tel:${FIRM.tel}`}>
                {FIRM.phone}
              </a>{' '}
              or email{' '}
              <a className="pp-link" href={`mailto:${FIRM.email}`}>
                {FIRM.email}
              </a>{' '}
              for a current quote.
            </p>
          ) : (
            <p className="pp-lead">{opener}</p>
          )}
        </header>

        <section className="pp-compare" data-compare data-pick="" aria-labelledby="pp-cmp-h">
          <h2 id="pp-cmp-h" className="pp-sr">
            What each option includes, service by service
          </h2>

          {/* The legend, and the only control above the figures: one mark per
              offered tier. Pressing one lights that tier through every figure
              below and at the totals. No price up here — the page opens on what
              the family gets, and the figures are what they came to read. */}
          <div className="pp-legend" role="group" aria-label="Highlight a tier">
            {offered.map((pkg) => (
              <button
                key={pkg}
                type="button"
                className="pp-legend-tier"
                data-pick-tier={pkg}
                aria-pressed="false"
              >
                <TierMark pkg={pkg} />
                <span>{PACKAGE_LABELS[pkg]}</span>
              </button>
            ))}
          </div>

          <div className="pp-figs">
            {baseRows.map((row) => (
              <Figure key={row.slug} row={row} glyph={<ServiceIcon slug={row.slug} />} />
            ))}
          </div>

          {offeredAddons.length > 0 && (
            <>
              <p className="pp-figs-label">Added to this proposal</p>
              <div className="pp-figs">
                {offeredAddons.map((row) => (
                  <Figure key={row.slug} row={row} glyph={<ServiceIcon slug={row.slug} />} />
                ))}
              </div>
            </>
          )}

          {/* The totals, LAST: the price is the closing line of the argument the
              figures make, not the first thing shouted. One figure per tier, the
              largest type on the page, with the single control under it. */}
          <div className="pp-tiers" style={{ '--pp-cols': offered.length }}>
            {offered.map((pkg) => (
              <div key={pkg} className="pp-tier" data-pkg={pkg}>
                <p className="pp-tier-name">
                  <TierMark pkg={pkg} />
                  {PACKAGE_LABELS[pkg]}
                </p>
                <p className="pp-tier-total">{money(quoteTotals.packages[pkg].total)}</p>
                {live && (
                  <a className="pp-choose" href={chooseHref(first, PACKAGE_LABELS[pkg])}>
                    <span>Choose</span>
                    <span>{PACKAGE_LABELS[pkg]}</span>
                  </a>
                )}
              </div>
            ))}
          </div>
          {!live && <p className="pp-tiers-note">These are the figures this proposal was priced at.</p>}

          {/* Add-ons nobody is being offered in this proposal, named once so a
              family who asks "do you do AP tutoring?" finds the answer without
              those rows competing with the ones that are on the table. */}
          {otherAddons.length > 0 && (
            <p className="pp-also">
              <span className="pp-also-label">Also available on request: </span>
              {otherAddons.map((r) => r.label).join(' · ')}
            </p>
          )}
        </section>

        {/* The letter: buildEmail's own sections, in buildEmail's own order,
            with nothing dropped. The comparison above is a lens on this copy;
            this is the copy. The per-tier option blocks live here, which is
            where the add-on prices, the bonus values and the discount lines
            are. The totals above are the CONTROL; the Payment Options block
            below is the same offer as the document of record. */}
        <div className="pp-letter">
          <p className="pp-letter-label">The full proposal</p>
          {sections.map((section) => (
            <section key={section.heading} id={slugify(section.heading)} className="pp-section">
              <h2 className="pp-h2">{section.heading}</h2>
              <Nodes nodes={sectionNodes(section.items)} />
            </section>
          ))}

          {steps.length > 0 && (
            <section className="pp-section" id="what-happens-next">
              <h2 className="pp-h2">What happens next</h2>
              <ol className="pp-steps">
                {steps.map((step) => (
                  <li key={step.heading}>
                    <h3 className="pp-h3">{step.heading}</h3>
                    {step.body.map((text, i) => (
                      <p key={i}>
                        <Linked text={text} />
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <footer className="pp-footer">
          {closing.map((text, i) => (
            <p key={i}>{text}</p>
          ))}
          {!enrolled && (
            <p className="pp-footer-custom">
              Prefer something other than these three?{' '}
              <a className="pp-link" href={customHref(first)}>
                Ask us about a custom plan
              </a>
              .
            </p>
          )}
          <p className="pp-footer-contact">
            <a className="pp-link" href={`tel:${FIRM.tel}`}>
              {FIRM.phone}
            </a>
            {' · '}
            <a className="pp-link" href={`mailto:${FIRM.email}`}>
              {FIRM.email}
            </a>
            {' · '}
            930 Roosevelt, Suite 221-225, Irvine, CA 92620
          </p>
        </footer>
      </main>

    </>
  );
}
