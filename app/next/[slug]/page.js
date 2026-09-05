import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { DateTime } from 'luxon';
import { getLead, maskEmail } from './leads';
import BookingBlock from './BookingBlock';
import HeardStrip from './heard';
import Reveal from './Reveal';
import NextList from './nextlist';
import { BookedFlag } from './LiveBits';
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

   Client components are few and small: BookingBlock, because picking a time is
   genuinely interactive, and the two bits in LiveBits.js (the live clock, the
   ?booked=1 flag) that only a browser can know. All of them still render to
   HTML on the server, so the first paint carries real times on both clocks
   and the true dateless clock sentence before any JavaScript runs. Review the
   page over the HTTPS surface: over plain HTTP the Clerk dev-instance
   handshake can stall hydration for the whole route, and then nothing here
   becomes tappable. */

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

/* ONE left edge for the whole page (2026-09-04, Aaron: "every hero should be
   left-aligned").
   ─────────────────────────────────────────────────────────────────────────
   Before this the page had two centred measures, a 38rem prose column and a
   54rem figure exception, so every wide block bled past the headings on BOTH
   sides and no two left edges agreed. Centring a narrow column also parks the
   headings in the middle third of a desktop screen, which is what made them
   read as floating rather than as the start of anything.

   Now one 54rem band is centred on the viewport and everything inside it
   starts at that band's left edge: prose stops at 34rem for measure, figures
   run the full width to the right. Trace the first glyph of any heading down
   the page and it is the same x as the calendar, the module strip and the tier
   cards. */
function Col({ children, className = '', ...rest }) {
  return (
    <Wide className={className} {...rest}>
      <div className="max-w-[34rem]">{children}</div>
    </Wide>
  );
}

/* The same band, without the prose cap: for anything that is looked at rather
   than read (the month grid, the module strip, the tier cards). */
function Wide({ children, className = '', ...rest }) {
  return (
    <div className={`mx-auto w-full max-w-[54rem] px-6 sm:px-8 ${className}`} {...rest}>
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

/* The live clock and the ?booked=1 flag are two small client components
   (LiveBits.js) that run AFTER hydration. They used to be one inline script
   that ran before it, and that is exactly why the dev overlay showed two issues
   on every load: the script rewrote the clock's text under React's feet and
   the whole tree was regenerated on the client. The clock's fallback sentence
   is what the server renders; the effect replaces it the instant the page is
   interactive. Nothing in the repo produces ?booked=1 today; the flag is kept
   because it costs ten lines and is what a confirmation link would carry. */

export default async function NextPage({ params }) {
  const { slug } = await params;
  const lead = await getLead(slug);
  if (!lead) notFound();

  const b = lead.booking || {};

  /* A closed page. The family followed a link somebody gave them, so this is a
     200 and a quiet sentence, never a 404: a 404 tells a person they typed
     something wrong when they did not, and it gives them nothing to do next.
     This one gives them the one thing that works. Nothing else on the page
     renders, so a closed lead exposes no prices and no calendar. */
  if (lead.status === 'closed') {
    return (
      <main className="next-page relative z-10 pt-24">
        <Col>
          <h1 className="font-display text-[2.2rem] font-normal leading-[1.1] tracking-[-0.02em] text-ink sm:text-[2.6rem]">
            This page has <em>closed.</em>
          </h1>
          <p className="mt-6 text-[17px] leading-relaxed text-ink-soft">
            Reply to Ryan&rsquo;s email and he will send a fresh one.
          </p>
          <div className="mt-12 border-t border-ink-faint/25 pt-8 text-[14px] leading-relaxed text-ink-faint">
            <p className="font-display text-[1.05rem] font-semibold text-ink-soft">
              {lead.footer?.name}
            </p>
            <p className="mt-1">{lead.footer?.firm}</p>
          </div>
        </Col>
      </main>
    );
  }

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

  /* One month, the family's current one (or the next, if this one is spent),
     with the first open day's times already in it. Null on failure: the block
     then shows its quiet empty sentence rather than an empty grid pretending
     to be knowledge. */
  let month = null;
  try {
    const res = await fetch(
      `${proto}://${host}/api/next/slots?slug=${encodeURIComponent(slug)}`,
      { cache: 'no-store' }
    );
    if (res.ok) {
      const json = await res.json();
      if (json?.month) month = json;
    }
  } catch (err) {
    console.error(`/next/${slug}: could not load availability`, err);
  }

  /* A family who already booked sees their booking, not a list of times. The
     row carries it, so this survives them closing the tab and coming back. */
  const bookedState = lead.booked
    ? {
        start: lead.booked.start,
        email: maskEmail(b.familyEmail),
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
      <BookedFlag />

      <main className="next-page relative z-10 pb-32 pt-16 sm:pb-24 sm:pt-24">
        {/* Scroll reveal. Renders nothing; it observes the [data-reveal] blocks
            below and lets each one arrive as the reader reaches it.

            TWO BLOCKS DELIBERATELY CARRY NO data-reveal. The greeting, because
            it is the first thing on screen and a page whose opening line fades
            itself in reads as slow rather than considered — Reveal.js would
            catch that anyway with its first-viewport rule, but the honest place
            to say "this never animates" is here, on the element. And the
            booking section, because it is the one part of this page that is a
            TOOL rather than a narrative: the sticky bar jumps to it by anchor,
            and a control that is still settling when the reader arrives by link
            is a control that feels broken. Apple animates the story and leaves
            the configurator alone; so does this. */}
        <Reveal />
        {/* A rehearsal page books Ryan's REAL calendar and sends a REAL
            invitation, which is the point of it, so the one thing it must never
            do is pass for a family's page. The pill renders only on a row that
            asked for it. */}
        {lead.rehearsal && (
          <div className="pointer-events-none absolute right-4 top-4 z-20">
            <span className="neu-chip rounded-full px-3 py-1 text-[12px] font-semibold text-terracotta-deep">
              rehearsal
            </span>
          </div>
        )}

        {/* ── 1. The greeting, then the three things ───────────────────────────
            "Hi Conor." on its own read as bare (2026-09-04, Aaron), and the
            reason is that it is a greeting from nobody: a name, no sender, no
            occasion. What warms it is not a paragraph, it is the two facts a
            form letter cannot hold. WHEN they spoke, said on the family's own
            clock rather than ours, which is the page quietly doing the time-zone
            work it spends the rest of its length doing. And WHO is speaking,
            signed, because every other word here is Ryan's.

            The line that used to sit here ("This page is for you and your
            parents: what I heard, what happens next, and a place to pick a
            time") is still gone and stays gone: it described the page it sat
            on, which is the deck-paragraph tic the pamphlets were swept for on
            2026-08-17. The test for anything in this slot is whether it could
            appear on another family's page unchanged. A date and a name cannot.

            The "What Ryan heard" eyebrow over the modules is also gone
            (2026-09-04, Aaron, asked twice). It labelled a strip that says what
            it is, and a label over a self-evident thing is narration. */}
        <Col>
          <h1 className="font-display text-[2.6rem] font-normal leading-[1.05] tracking-[-0.02em] text-ink sm:text-[3.4rem]">
            Hi <em>{lead.student}.</em>
          </h1>
          {lead.welcome && (
            <p className="welcome mt-3">
              {lead.welcome}
              {lead.welcomeFrom && <span className="welcome-from">{lead.welcomeFrom}</span>}
            </p>
          )}
        </Col>
        {/* The strip takes the page's measure exception at the wide breakpoint,
            like the tier cards: it is a diagram, not prose, and three modules
            inside a prose column wrap every line three times. The eyebrow above
            it stays on the page's own left edge with everything else that is
            read as text. */}
        {/* mt-12, against the greeting line's mt-3 (2026-09-04, Aaron: the
            spacing "looks wrong here for Hi Aaron / It was good to talk on
            Wed... / Icons", and the greeting line "should be higher up, i.e.,
            closer to the Hi Aaron hero").
            Both gaps were mt-5, which spaced the three blocks EVENLY and so
            grouped nothing: the sentence Ryan is saying to this family read as
            equally far from his greeting as from a diagram it has no relation
            to. The greeting and its line are one utterance and now sit as one;
            the strip is the next thing and gets the real break. Proximity is
            the grouping mechanism here, not a rule or a heading — there is no
            eyebrow over the strip any more, so spacing is all that is left to
            say where one thing ends. */}
        <Wide className="mt-12" data-reveal>
          <HeardStrip items={lead.heard} />
        </Wide>

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

        {/* ── 4. The clock: DELETED 2026-09-04 (Aaron) ────────────────────────
            A live two-city sentence used to sit here. It was the third time the
            page said the same thing: every time chip carries both clocks and so
            does the confirm line, so the sentence was telling the family to do
            arithmetic the control below had already done for them. The row's
            clockFallback and clockTail are left in the data, unread, so that a
            lead who genuinely needs a framing line can have one without the
            component coming back from git. */}

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
              {/* The row's zoneNote ("Friday evening in California is Saturday
                  morning in Singapore") is deliberately NOT rendered any more:
                  every chip and every day now carries both clocks, so the
                  sentence restated what the control shows. */}
            </div>
          </Col>

          {/* The control takes the page's wide-figure exception at lg, the same
              one the tier cards take, because from 1024px it is two columns and
              a 38rem prose measure cannot hold a month grid beside a column of
              chips. Everything above it that is READ stays on the prose column
              with the rest of the page's text. */}
          <Wide className="unbooked-only">
            <BookingBlock
              slug={slug}
              initial={{ month, booked: bookedState }}
              copy={{
                booked: b.booked || { heading: 'Booked.', body: 'Nothing to prepare.' },
                confirmLabel: b.confirmLabel || 'Confirm this time',
                emptyLabel:
                  b.emptyLabel ||
                  "Ryan's calendar could not be loaded just now. Refresh the page, or email us and we will find a time.",
              }}
            />
          </Wide>
        </section>
        {/* ── 6. What happens in that conversation ──────────────────────────
            A running order, not prose: three stages of the meeting as a list,
            then the one line that is not a stage. The list takes the page's
            wide-figure measure so three stages can sit across at lg instead of
            queueing down a 34-character-wide prose column that had no reason to
            be narrow. The heading stays on the page's own left edge with
            everything else that is read as a sentence. */}
        <Col className="mt-16" data-reveal>
          <H2>
            <Accent text={lead.next.heading} />
          </H2>
        </Col>
        <Wide className="mt-7" data-reveal>
          <NextList lines={lead.next.lines} />
        </Wide>

        {/* ── 7. Families outside the United States ───────────────────────────
            Every sentence is one the International Families pamphlet already
            prints. The pamphlet's own school-night clause is left out on
            purpose: it is true of a Saturday and false of a weekday. */}
        <Col className="mt-16" data-reveal>
          {/* The one figure worth keeping off the deleted three-up row, placed
              where the question it answers is actually being asked: a family in
              Singapore wondering whether this firm has done this before. Above
              the heading rather than below it, because it is the reason to read
              the section, not a footnote to it. */}
          {lead.international.stat && (
            <p className="intl-stat">
              <span className="intl-stat-figure">{lead.international.stat.figure}</span>
              <span className="intl-stat-label">{lead.international.stat.label}</span>
            </p>
          )}
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
        <section className="mt-20" data-reveal>
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

          {/* The three-figure row that sat here is GONE (2026-09-04, Aaron).
              Three numerals in a row is the shape a landing page uses when it
              has nothing specific to say, and two of these three were not worth
              the space: the 95% referral figure is about how the firm gets its
              clients, which is the firm's business and not this family's, and
              the 22+ years is undecided. The one that was doing real work,
              "12+ countries where our students have enrolled", moved to the
              section where a family in Singapore is actually asking the
              question it answers. The figures all remain in proof.stats, so
              placing any of them again is a data edit, not a rebuild. */}

          {/* The fragment carries its own attribution as its heading, which is
              why this block has no invented section title over it.

              BOUND TO THE PHOTOGRAPH ABOVE, not floating under it (2026-09-04,
              Aaron: the essay and the Paraguay image "feel orphaned, not
              integrated"). Three things were keeping them apart, and none of
              them was the gap between them:

              The rule and its 1.25rem indent gave this block a left edge of its
              own. Every heading, the calendar, the module strip and the
              photograph's own caption sit on one x — that was the whole point of
              the 09-04 layout pass — and the one block that opted out was this
              one, so the eye read it as imported from somewhere else. It now
              starts where everything else starts.

              At 19px display italic against 15px body sans it was also the
              loudest typography in the region, which inverted the section: a
              former student's essay was shouting over the photograph of Ryan
              actually doing the work. 17px keeps it clearly a different voice
              without letting it lead.

              And the two captions now match exactly — same size, same colour,
              same left edge — so the photograph and the fragment read as two
              exhibits under one labelling system rather than two unrelated
              objects. That shared label is what does the integrating; the
              tightened gap just stops them looking like separate sections. */}
          <Col className="mt-10">
            <figure>
              <blockquote className="font-display text-[17px] italic leading-relaxed text-ink">
                <p>{lead.proof.essay}</p>
              </blockquote>
              <figcaption className="mt-4 text-[14px] leading-relaxed text-ink-faint">
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
        <section className="mt-20" data-reveal>
          <Col>
            <H2>
              <Accent text={lead.packages.heading} />
            </H2>
          </Col>

        <Wide className="mt-8" data-reveal>
          <div className="grid gap-5 lg:grid-cols-3 lg:gap-4">
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
        </Wide>

        {/* The pamphlet, under the ladder it describes (2026-09-04, Aaron:
            "can the page host the full PDF of our 9-11 pamphlet, available for
            download?").
            HERE rather than in the footer, where the other PDF slot lives: a
            family that wants this in writing wants it at the moment they are
            reading prices, not after the phone number. It is a plain link with
            the download attribute rather than a button — the page has one
            action, and that action is booking a time; a second button beside
            the ladder would compete with it for the same tap.
            The label carries the file type because a link that silently starts
            a download is a link that has surprised someone. */}
        {lead.packagesPdf && (
          <Col className="mt-7" data-reveal>
            <a className="pdf-chip" href={lead.packagesPdfHref} download>
              {lead.packagesPdfLabel}
            </a>
          </Col>
        )}

        <Col className="mt-6" data-reveal>
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
        <Col className="mt-20" data-reveal>
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
