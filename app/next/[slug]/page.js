import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { DateTime } from 'luxon';
import { getLead } from './leads';
import BookingBlock from './BookingBlock';
import { describeSlot } from '@/lib/nextBooking';

/* /next/<slug> — the page a family lands on from the first post-consult email.
   ─────────────────────────────────────────────────────────────────────────
   One job: get the second conversation booked, at the lowest possible cost to
   the family. The 2026-09-01 research verdict is that the second meeting IS the
   product and the proposal is presented live in it, so this page does not sell
   the package. It shows the family that Ryan listened, gives them a calendar,
   and gets out of the way.

   What follows from that:

   · The greeting is the loudest thing on the page, before the calendar and long
     before the prices. It is the whole difference between this and a PDF: the
     page knows who opened it. Blurred to illegibility it still reads as a
     personal address, which is the one thing a template cannot fake.
   · There is exactly ONE booking door and it is OURS. The family books Ryan's
     real calendar through the portal's own engine, on the same availability
     code a signed-in student books through, so they are never offered a time
     the gate would refuse. Nothing is held for them while they decide. A sticky
     bar keeps that door reachable from the first screen on a phone.
   · Every time on the page is shown in BOTH zones, Singapore first. Fifteen
     hours of offset is the thing most likely to make this family misread their
     own calendar, and no sentence anywhere claims a meeting fits before the student's
     school day, because at 5 pm Irvine it is the middle of their first period.
   · Every fact traces to Ryan's read, to copy a pamphlet already prints, or to
     the price card. The single Claude-written block on the page (the UK/US
     shape) is gated behind a JSON boolean that ships OFF, so it cannot reach a
     family before Ryan nods.
   · No DocuSign, no payment link, no builder link, no expiring bonus, no
     "agreement". Ryan's two-email ruling (Claude_Services.md section 6): first
     contact carries the conversation, the second email carries the paperwork.

   No auth. The lead data is one Supabase row and the availability is one live
   read of Ryan's calendar, both on this render.

   ONE client component, BookingBlock, and only because picking a time is
   genuinely interactive. It still renders to HTML on the server, so the first
   paint carries real times on both clocks before any JavaScript runs. The live
   clock and the ?booked=1 state stay OFF React entirely, in a small inline
   script, because the Clerk dev-instance handshake can stall hydration for a
   whole route over plain HTTP, and a clock that only works in production is a
   clock that lied during every review. */

/* Rendered per request, not prerendered. The lead data lives in a Supabase row
   rather than in a file the build can see (app/next/[slug]/leads.js explains
   why), so a new family is an INSERT and needs no rebuild and no deploy. An
   unknown slug still ends at notFound(), which is a plain 404. */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const lead = await getLead(slug);
  return {
    title: lead ? `Admissions.Partners · ${lead.student}` : 'Admissions.Partners',
    /* Repeated here as well as on the layout because this is the object that
       wins for this route, and a page carrying a family's contact details and
       their quoted prices must never be indexed, followed, cached as a snippet,
       or turned into a search preview. nofollow matters as much as noindex: a
       crawler that indexed nothing could still walk every link out of the page.
       The X-Robots-Tag header in next.config.mjs says the same thing at the
       transport layer, on both hosts, so a crawler that never parses the head is
       covered too. */
    robots: { index: false, follow: false, nocache: true },
    /* Any cross-origin request this page makes sends only the ORIGIN, never the
       path. The path IS the secret: the unguessable slug is what authorizes a
       family to read their own prices, and a full-URL Referer would hand it to
       a third party on every load. This is the browser default in modern
       engines and is stated anyway, because a default is not a decision. */
    referrer: 'strict-origin-when-cross-origin',
  };
}

/* The text column. One measure for the whole page (about 68 characters at the
   body size), set once here rather than per section, so every first glyph on
   the page sits on the same left edge at every width. The photograph is the one
   thing that leaves it. */
function Col({ children, className = '', ...rest }) {
  return (
    <div className={`mx-auto w-full max-w-[38rem] px-6 sm:px-8 ${className}`} {...rest}>
      {children}
    </div>
  );
}

function H2({ children }) {
  return (
    <h2 className="font-display text-[1.9rem] font-normal leading-tight tracking-[-0.015em] text-ink sm:text-[2.2rem]">
      {children}
    </h2>
  );
}

/* Split a heading so the last word carries the italic terracotta accent, which
   is the house language's strongest signal and the only ornament on this page.
   Done here rather than by writing markup into the JSON, so the copy stays copy
   and a lead file can never ship a broken tag. */
function Accent({ text }) {
  const words = text.trim().split(' ');
  const last = words.pop();
  return (
    <>
      {words.join(' ')} <em>{last}</em>
    </>
  );
}

/* The live clock and the booked state, as one inline script.

   Why not a client component: this route has none, and adding one would make
   both features depend on React hydration, which the Clerk dev instance can
   stall indefinitely over plain HTTP. This runs on parse, before paint, on any
   browser with scripting on. With scripting OFF the page still says the true
   thing, because the fallback sentence is what the server rendered.

   The clock is computed from the two zone names via Intl, never from a typed
   offset, so it stays right through a daylight-saving change. Each side names
   its own DAY rather than describing the other one: "5:12 pm Friday in Irvine"
   is a fact the reader can act on, where "5:12 pm yesterday" makes them work
   out whose yesterday it is, in the one sentence on the page whose entire job
   is to stop them doing time-zone arithmetic.

   The ?booked=1 state flips one attribute on <html> and lets CSS do the swap.
   It is now the SECONDARY path: the authoritative booked state comes from the
   lead's own row, server-rendered, so it survives the family closing the tab
   and coming back on another device. The query flag is what a confirmation link
   in an email can carry, and it costs one attribute to honour. */
const BROWSER_SCRIPT = `(function(){
  /* The booked flag is set IMMEDIATELY, before the browser has painted, so a
     family who already booked never sees a calendar flash on screen first. It
     only touches documentElement, which exists the moment this script runs. */
  try {
    var p = new URLSearchParams(location.search);
    if (p.get('booked') === '1' || p.get('event_start_time')) {
      document.documentElement.setAttribute('data-booked', '1');
    }
  } catch (e) {}

  /* The clock CANNOT run immediately: this script is the first thing in the
     body and its target span is several sections below it, so an early call
     finds null and silently leaves the fallback sentence on screen, which is
     exactly how a "live" clock ships dead. Wait for the document, or run now if
     it is already parsed. */
  function clock() {
  var el = document.getElementById('local-clock');
  if (!el) return;
  function part(zone) {
    var now = new Date();
    var t = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true
    }).format(now).toLowerCase().replace(/\\s/g, ' ');
    var day = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, weekday: 'long'
    }).format(now);
    return { time: t, day: day };
  }
  try {
    var sg = part('Asia/Singapore');
    var la = part('America/Los_Angeles');
    el.textContent = 'It is ' + sg.time + ' ' + sg.day + ' in Singapore and '
      + la.time + ' ' + la.day + ' in Irvine.';
  } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', clock);
  } else {
    clock();
  }
})();`;

export default async function NextPage({ params }) {
  const { slug } = await params;
  const lead = await getLead(slug);
  if (!lead) notFound();

  const b = lead.booking || {};

  /* Availability is read on THIS render, from Ryan's live calendar, so the
     first paint carries times that were true a moment ago rather than times a
     build baked in.
​
     It goes through this app's OWN slots endpoint rather than calling Google
     from here, and that is a measured constraint rather than a preference:
     googleapis' response handling does not survive a React Server Component
     render under Next 16. Calling it here fails the whole page with
     "TypeError: ArrayBuffer is not detachable and could not be cloned" during
     response streaming, while the identical call inside a route handler works.
     Isolated on 2026-09-03 by keeping the import and skipping only the call,
     which rendered 200. The same-origin hop is the price of a page that renders
     at all.

     The origin is derived from the REQUEST, never hardcoded, so this works
     unchanged on portal.admissions.partners and on book.ryanchoice.com, where
     the very same page is served from the root.

     A failure here must never take the page down: the block falls back to its
     empty state and the client re-asks. */
  const h = await headers();
  const host = h.get('host');
  const proto = h.get('x-forwarded-proto') || (host?.startsWith('localhost') || host?.startsWith('127.') ? 'http' : 'https');

  let availability = { days: [] };
  try {
    const res = await fetch(
      `${proto}://${host}/api/next/slots?slug=${encodeURIComponent(slug)}`,
      { cache: 'no-store' }
    );
    if (res.ok) availability = await res.json();
  } catch (err) {
    console.error(`/next/${slug}: could not load availability`, err);
  }

  /* A family who already booked sees their booking, not a list of times. The
     row carries it, so this survives them closing the tab and coming back. */
  const bookedState = lead.booked
    ? {
        start: lead.booked.start,
        email: b.familyEmail || null,
        slot: describeSlot(
          {
            start: lead.booked.start,
            end: DateTime.fromISO(lead.booked.start)
              .plus({ minutes: b.durationMinutes || 30 })
              .toISO(),
          },
          b.timezone || 'Asia/Singapore',
          b.zoneLabel || 'Singapore time'
        ),
      }
    : null;

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: BROWSER_SCRIPT }} />

      <main className="next-page relative z-10 pb-32 pt-16 sm:pb-24 sm:pt-24">
        {/* ── 1. The greeting ─────────────────────────────────────────────── */}
        <Col>
          <h1 className="font-display text-[2.6rem] font-normal leading-[1.05] tracking-[-0.02em] text-ink sm:text-[3.4rem]">
            Hi <em>{lead.student}.</em>
          </h1>
          <p className="mt-6 text-[17px] leading-relaxed text-ink-soft">{lead.opening}</p>
          <p className="mt-4 font-display text-[1.1rem] font-semibold text-ink">{lead.signature}</p>
        </Col>

        {/* ── 2. What I heard ─────────────────────────────────────────────────
            Four short blocks, each led by the thing itself in bold. A list of
            named facts is read; the same four facts inside a paragraph are
            skimmed, and being read is the entire point of this section. */}
        <Col className="mt-14">
          <p className="eyebrow">What I heard</p>
          <div className="mt-5">
            {lead.heard.map((item, i) => (
              <div
                key={item.lead}
                className={`py-4 ${i > 0 ? 'border-t border-ink-faint/20' : ''}`}
              >
                <p className="text-[17px] leading-relaxed text-ink-soft">
                  <strong className="font-semibold text-ink">{item.lead}</strong> {item.body}
                </p>
              </div>
            ))}
          </div>
        </Col>

        {/* ── 3. The video slot ───────────────────────────────────────────────
            Rendered only when this lead has a film. An empty frame promising a
            video that does not exist is worse than no section, so the absent
            case renders nothing rather than a placeholder. */}
        {lead.video && (
          <Col className="mt-14">
            <div className="neu-raised overflow-hidden rounded-[1.75rem]">
              {/\.(mp4|webm|mov)$/i.test(lead.video) ? (
                <video
                  className="aspect-video w-full"
                  controls
                  playsInline
                  preload="metadata"
                  src={lead.video}
                />
              ) : (
                <iframe
                  className="aspect-video w-full"
                  src={lead.video}
                  title={`A short message for ${lead.student}`}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              )}
            </div>
            {lead.videoCaption && (
              <p className="mt-3 text-[14px] leading-relaxed text-ink-faint">{lead.videoCaption}</p>
            )}
          </Col>
        )}

        {/* ── 4. The clock ────────────────────────────────────────────────────
            The server renders the true, dateless fallback. The inline script
            replaces it with the live one. Neither version can be stale, which
            is the whole reason the sentence is not typed. */}
        <Col className="mt-12">
          <p className="text-[16px] leading-relaxed text-ink-soft">
            <span id="local-clock" className="font-semibold text-ink">
              {lead.clockFallback}
            </span>{' '}
            {lead.clockTail}
          </p>
        </Col>

        {/* ── 5. The booking block ────────────────────────────────────────────
            The family books Ryan's real calendar here. No Calendly, no embed,
            no hand-off to a third party and no UTM: the booking is the portal's
            own, it lands on the same calendar a student booking lands on, and
            the lead slug rides on the event and on the row, which is the
            attribution the query string used to carry badly.

            The times are computed LIVE, on this render, from Ryan's calendar,
            and re-verified live when the family taps confirm. NOTHING IS HELD
            for them in between: a pre-reserved slot is a meeting Ryan cannot
            see, nothing ever releases it, and four slots held for one family
            are three slots taken from every other family. The cost of that
            honesty is a race, and the confirm step is where the race is
            resolved rather than hidden.

            BookingBlock is a client component, which in the App Router still
            renders to HTML on the server: the first paint carries real times,
            already on both clocks, before any JavaScript has run. What
            JavaScript adds is the ability to tap one. */}
        <section id="pick-a-time" className="mt-16 scroll-mt-8">
          <Col>
            <H2>
              <Accent text={b.heading} />
            </H2>

            <div className="booked-only mt-6">
              <div className="neu-raised rounded-[1.75rem] p-7">
                <p className="font-display text-[1.5rem] font-semibold leading-tight text-ink">
                  {b.booked?.heading}
                </p>
                <p className="mt-2 text-[16px] leading-relaxed text-ink-soft">{b.booked?.body}</p>
              </div>
            </div>

            <div className="unbooked-only">
              <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">{b.sub}</p>
              {b.zoneNote && (
                <p className="mt-2 text-[16px] leading-relaxed text-ink-soft">{b.zoneNote}</p>
              )}

              <BookingBlock
                slug={slug}
                initial={{ days: availability.days || [], booked: bookedState }}
                copy={{
                  booked: b.booked || { heading: 'Booked.', body: 'Nothing to prepare.' },
                  confirmLabel: b.confirmLabel || 'Confirm this time',
                  emptyLabel:
                    b.emptyLabel ||
                    'No mornings are open in the next two weeks. Email us and we will find one.',
                }}
              />
            </div>
          </Col>
        </section>
        {/* ── 6. What happens in that conversation ────────────────────────── */}
        <Col className="mt-16">
          <H2>
            <Accent text={lead.next.heading} />
          </H2>
          <div className="mt-5 space-y-4 text-[17px] leading-relaxed text-ink-soft">
            {lead.next.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </Col>

        {/* ── 7. Families outside the United States ───────────────────────────
            Every sentence is one the International Families pamphlet already
            prints. The pamphlet's own school-night clause is left out on
            purpose: it is true of a Saturday and false of a weekday. */}
        <Col className="mt-16">
          <H2>
            <Accent text={lead.international.heading} />
          </H2>
          <div className="mt-5 space-y-4 text-[17px] leading-relaxed text-ink-soft">
            {lead.international.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>

          {/* The one Claude-written block on the page, gated OFF until Ryan
              nods. Dateless by construction: the order of the stages and the
              fact that one sequence runs earlier, and not one month, deadline
              or test name, because none of those has been ratified by anyone
              here and a wrong deadline in front of a family is the one error
              this page cannot survive. */}
          {lead.uk_us_shape && (
            <div className="neu-raised mt-8 rounded-[1.75rem] p-7">
              <p className="font-display text-[1.25rem] font-semibold leading-snug text-ink">
                {lead.ukUsShape.heading}
              </p>
              <div className="mt-5 grid gap-6 sm:grid-cols-2">
                {lead.ukUsShape.columns.map((c) => (
                  <div key={c.label}>
                    <p className="eyebrow">{c.label}</p>
                    <ul className="ticks mt-3 space-y-2 text-[16px] leading-relaxed text-ink">
                      {c.steps.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
                {lead.ukUsShape.tail}
              </p>
            </div>
          )}
        </Col>

        {/* ── 8. The register ─────────────────────────────────────────────────
            Real material only: a photograph Ryan took, three figures the firm
            already prints, a fragment of an essay a former student consented to
            us using, and the results line the pamphlet carries. No testimonials
            (the eleven on file are unconsented) and no named admits.

            The photograph is the only thing on the page that leaves the text
            column, and it earns that by being the only thing that is not
            words. */}
        <section className="mt-20">
          <figure>
            <img
              className="band"
              src="/next/paraguay-band.jpg"
              alt={lead.proof.alt}
              width={2550}
              height={465}
            />
            <Col>
              <figcaption className="mt-4 text-[14px] leading-relaxed text-ink-faint">
                {lead.proof.caption}
              </figcaption>
            </Col>
          </figure>

          <Col className="mt-10">
            <dl className="grid grid-cols-1 gap-6 sm:grid-cols-3">
              {lead.proof.stats.map((s) => (
                <div key={s.figure}>
                  <dt className="font-display text-[2rem] font-normal leading-none text-ink">
                    {s.figure}
                  </dt>
                  <dd className="mt-2 text-[14px] leading-snug text-ink-faint">{s.label}</dd>
                </div>
              ))}
            </dl>
          </Col>

          {/* The fragment carries its own attribution as its heading, which is
              why this block has no invented section title over it. */}
          <Col className="mt-14">
            <figure>
              <blockquote className="border-l-2 border-terracotta/60 pl-5 font-display text-[19px] italic leading-relaxed text-ink">
                <p>{lead.proof.essay}</p>
              </blockquote>
              <figcaption className="mt-4 pl-5 text-[14px] leading-relaxed text-ink-faint">
                {lead.proof.essayLabel}
              </figcaption>
            </figure>
          </Col>

          {/* The pamphlet's 2025-26 results line was here and is deliberately
              GONE. It reads "internships placed at the UN, Deloitte, and
              Felicitas Global Partners", and "placed" reads to a family as a
              promise of placement rather than as a record of what past students
              did. The three figures above carry the same reassurance without
              committing the firm to an outcome. This is not a formatting cut:
              do not restore the line without a ruling on that word. */}
        </section>

        {/* ── 9. The packages ─────────────────────────────────────────────────
            The ladder, not a quote. Three peer columns on desktop, three
            stacked blocks on a phone. No tier is starred, emphasised, or
            ordered by preference, and Ultra VIP carries no figure on any
            family-facing surface. */}
        {/* The page has exactly one exception to its measure and this is its
            second use: a WIDE FIGURE with its words back in the column. The
            photograph does it above, bleeding past the text with its caption
            returned to the column edge, and the tier cards do it here for the
            same reason. Three tiers inside a 68-character prose column give
            each about 190px, which breaks every feature line onto three lines
            and turns a comparison into three paragraphs; the measure exists for
            prose, and this is a table wearing cards.

            Heading and notes stay on the page's own left edge, so nothing that
            is read as text sits on a second edge. Only the cards move. */}
        <section className="mt-20">
          <Col>
            <H2>
              <Accent text={lead.packages.heading} />
            </H2>
          </Col>

          <div className="mx-auto mt-8 grid w-full max-w-[38rem] gap-5 px-6 sm:px-8 lg:max-w-[54rem] lg:grid-cols-3 lg:gap-4">
            {lead.packages.tiers.map((tier) => (
              <div key={tier.name} className="neu-raised flex flex-col rounded-[1.75rem] p-6">
                <p className="font-display text-[1.25rem] font-semibold leading-snug text-ink">
                  {tier.name}
                </p>
                {/* A figure and a phrase are not the same typographic object.
                    "$44,000" wants display size; "By conversation" set at the
                    same size wraps to two lines and shouts louder than the two
                    prices it sits beside, which is the nudge the house rule
                    forbids. Sized by what the string IS, not by its slot. */}
                <p
                  className={`mt-2 font-display font-normal text-ink ${
                    /\d/.test(tier.price)
                      ? 'text-[1.75rem] leading-none'
                      : 'text-[1.25rem] leading-snug'
                  }`}
                >
                  {tier.price}
                </p>
                {tier.badge && (
                  <p className="mt-2 text-[13px] font-semibold text-terracotta-deep">{tier.badge}</p>
                )}
                <ul className="ticks mt-5 space-y-2 text-[15px] leading-relaxed text-ink-soft">
                  {tier.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <Col className="mt-6">
            <div className="space-y-1 text-[14px] leading-relaxed text-ink-faint">
              {lead.packages.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
            </div>
          </Col>
        </section>

        {/* ── 10. The footer ──────────────────────────────────────────────────
            The firm's contact block in the form the pamphlets print it. The en
            dash in the suite range is theirs; the hyphens in the phone number
            are a compound, not a range. */}
        <Col className="mt-20">
          <div className="border-t border-ink-faint/25 pt-8 text-[14px] leading-relaxed text-ink-faint">
            <p className="font-display text-[1.05rem] font-semibold text-ink-soft">
              {lead.footer.name}
            </p>
            <p className="mt-1">{lead.footer.firm}</p>
            <p className="mt-3">{lead.footer.address}</p>
            <p>
              <a className="hover:text-terracotta-deep" href={`tel:+1${lead.footer.phone.replace(/\D/g, '')}`}>
                {lead.footer.phone}
              </a>
            </p>
            <p>
              <a className="hover:text-terracotta-deep" href={`mailto:${lead.footer.email}`}>
                {lead.footer.email}
              </a>
            </p>
            {lead.intl_pdf && (
              <p className="mt-4">
                <a
                  className="text-terracotta-deep underline underline-offset-2"
                  href={lead.intlPdfHref}
                >
                  {lead.intlPdfLabel}
                </a>
              </p>
            )}
          </div>
        </Col>
      </main>

      {/* ── The sticky bar ──────────────────────────────────────────────────
          Reachable from the first screen on a phone, which is where this page
          is read. It is an anchor to the block above, not a second booking
          door: it moves the page, it does not open anything. Hidden once the
          family has booked, and hidden on desktop, where the whole page is a
          short scroll and a fixed bar over the content buys nothing. */}
      <div className="sticky-book unbooked-only lg:hidden">
        <a href="#pick-a-time" className="sticky-book-btn">
          {b.stickyLabel}
        </a>
      </div>
    </>
  );
}
