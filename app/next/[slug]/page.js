import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { DateTime } from 'luxon';
import { getLead, maskEmail } from './leads';
import BookingBlock from './BookingBlock';
import HeardStrip from './heard';
import Reveal from './Reveal';
import NextList from './nextlist';
import Shortlist from './shortlist';
import { BookedFlag } from './LiveBits';
import { describeSlot } from '@/lib/nextBooking';
import { getInstructor } from '@/lib/instructors';

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
   · A row may ask for LIGHT mode ("mode": "light"), and then none of the
     booking paragraph below applies: the page carries the brochures and one
     mailto that says yes, and offers no time at all. Ryan's ruling of
     2026-09-07, and the reason is his: a free half hour offered to everyone is
     a half hour spent on everyone. Everything else on the page is the same.
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

  /* LIGHT MODE (2026-09-07 evening, Ryan via Aaron; supersedes the afternoon
     ruling where the two conflict).
     ────────────────────────────────────────────────────────────────────────
     Ryan's words: "light version: after the first initial, they get a
     stripped-down version of the pamphlet that has NO pricing in the /lead; if
     you're interested, let us know so we can move on to the next stage."

     A light page GAUGES INTEREST. It carries the brochures and the overview and
     nothing else, and the one action on it is a family saying yes. What it must
     never carry is a calendar, and that is Ryan's own fear stated plainly: "if
     light gets access to the calendar, everyone will book for a free 30 min even
     if they have NO intention of signing up." The free thirty minutes is
     something a family EARNS by asking real questions in a reply, or that Ryan
     GRANTS by escalating them to the heavy page. So the whole booking apparatus
     is gone here rather than hidden: no month grid, no sticky bar, no anchor to
     jump to, no calendar read, and no sentence anywhere promising a second
     conversation.

     A row without `mode`, or with `mode: "heavy"`, renders exactly what it
     rendered before this branch. That is not a courtesy: Conor's row is LIVE, so
     the absent case has to be the identical page, and every new branch below is
     gated on this one boolean rather than on the absence of some other field.
     ESCALATION IS ONE SEED, in either direction: flip `mode` to "heavy", stamp
     `escalatedAt` and `escalatedBy` (the family asked, or Ryan decided), re-seed,
     and the calendar is back. Nothing else on the row moves, which is why the
     `booking` object stays filled in on a light row and is simply unread. */
  const isLight = lead.mode === 'light';
  /* Server-side only, which is why it can come from lib/instructors rather than
     the client-safe half: this component never ships to the browser, and the
     one field the client needs (zoomLink) is handed over explicitly below. */
  const instructor = getInstructor(b.instructor);

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
     to be knowledge.

     NOT READ AT ALL ON A LIGHT PAGE. There is no calendar to fill, and asking
     Google for Ryan's availability to render a page that offers none is a live
     API call bought for nothing. It also keeps the guarantee honest at the
     source: a light page cannot leak a time because it never learns one. */
  let month = null;
  if (!isLight) {
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

  /* THE READING STRIP'S DOCUMENTS, from the row (2026-09-07, Ryan via Aaron).
     ────────────────────────────────────────────────────────────────────────
     The section used to be two hardcoded booleans, one per pamphlet, each with
     its own label and href field beside it. That shape could express exactly
     two documents, in one order, forever, and the two it could express were
     both fee-bearing, so the round-one no-price ruling switched both off and
     took the whole section with them. What the ruling actually forbids is an
     OFFER; what Ryan's round one is made of is "tons of info about Admissions
     Partners", the firm and the craft. Those are price-free documents, there
     are more than two of them, and which ones belong in front of a family is a
     fact about that family. So the row carries a LIST:

       "docs": [ { "label": "...", "href": "...", "note": "..." }, ... ]

     `note` is optional and is the one line saying what the document is for.

     BOTH SHAPES ARE READ, and the old one is not deprecated on Conor's behalf:
     his row is live, it still carries the two booleans, and it must render
     exactly what it renders today. A row with no `docs` is therefore mapped
     from the booleans here, in the same order they used to appear in, so the
     old row produces the identical list the old markup produced. A row that
     carries `docs` uses it and ignores the booleans. */
  const docs =
    Array.isArray(lead.docs) && lead.docs.length > 0
      ? lead.docs.filter((d) => d && d.label && d.href)
      : [
          lead.packagesPdf && { label: lead.packagesPdfLabel, href: lead.packagesPdfHref },
          lead.intl_pdf && { label: lead.intlPdfLabel, href: lead.intlPdfHref },
        ].filter(Boolean);

  /* The strip picks its FORM from the data, the way the meeting list does.
     Nobody's notes are half-written: either this row explains its documents or
     it does not. With no notes the chips stay the inline wrapping row they have
     always been, which is what keeps Conor's page identical to the pixel. With
     notes, a wrapping row cannot hold them — a note under a pill in a flex row
     drags the row's items onto different baselines and the set stops reading as
     peers — so each document becomes a block, chip over note, every one of them
     starting on the same left edge as the heading above and the footer below. */
  const docsHaveNotes = docs.some((d) => d.note);

  /* A CHIP TELLS THE TRUTH ABOUT WHERE IT GOES (2026-09-07). Every document
     used to be a PDF sitting in public/next/, so one treatment was honest for
     all of them: a file-down glyph and a `download` attribute. Half the strip
     is now Ryan's guides on go.ryanchoice.com, and on those the same treatment
     was wrong twice over. `download` is IGNORED cross-origin, so the attribute
     promised a saved file and delivered a navigation; and the glyph promised a
     file where a web page opens. Worse, the family left a page whose one job is
     to get a conversation booked, in the same tab, with nothing to come back to.

     An external chip therefore opens in a new tab (rel="noopener", which is
     what makes that safe) and takes an arrow-out-of-a-box glyph, which is the
     Lucide ideograph for "this leaves here". A hosted file keeps `download` and
     the file glyph, because for it both are still true. Derived from the href
     rather than declared per row, so a document cannot be labelled wrongly by a
     typo in a data file. */
  const isExternal = (href) => /^https?:\/\//i.test(href || '');

  /* One address or several, normalised here so the footer markup stays a map
     rather than a conditional. `emails` wins when a row carries it. */
  const footerEmails = Array.isArray(lead.footer.emails)
    ? lead.footer.emails.filter(Boolean)
    : [lead.footer.email].filter(Boolean);

  /* The light page's one action. Defaults live here rather than in the data so
     a row that says nothing but `"mode": "light"` still renders a complete
     block; a row that wants its own voice (Ryan speaks in the first person on
     some pages and is spoken about on others) overrides any field. */
  const interest = lead.interest || {};
  /* ryan@ryanchoice.com, not ryan@admissions.partners. The second is an ALIAS of
     support@ and nothing watches it as a lead inbox; the first is the mailbox
     the lead watcher actually reads. A yes that lands where nobody is looking is
     the one failure this whole mode exists to prevent. */
  const interestTo = interest.to || 'ryan@ryanchoice.com';
  /* SUBJECT ONLY, and the subject carries nothing about the family but the
     student's first name. A prefilled BODY puts words in a parent's mouth and
     then gets sent verbatim, which reads as a form response to the person who
     receives it; and everything the subject says travels through whatever
     unencrypted hop the family's mail takes. What we need back is a yes, and a
     subject line is a yes. */
  const interestSubject = interest.subject || `Options for ${lead.student}`;
  /* THE PREFILLED BODY IS GONE AGAIN (2026-09-08, Ryan via Aaron), and this
     time for a reason that outranks both earlier positions. Ryan's stated goal
     for this door is that a family "reply to that email with questions/concerns
     ... so that we can then offer custom packages". A body reading "Yes, please
     send options" hands a parent a finished message: they send it and write
     nothing, which is exactly the information the door exists to collect. The
     prefill did not merely risk putting words in their mouth, it suppressed the
     answer. Subject only, so the mail opens with an empty body and a cursor.
     A row may still set `body` if some future family needs a scaffold. */
  const interestHref =
    `mailto:${interestTo}?subject=${encodeURIComponent(interestSubject)}` +
    (interest.body ? `&body=${encodeURIComponent(interest.body)}` : '');

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

        {!isLight && (
        <section id="pick-a-time" className="mt-16 scroll-mt-8">
          <Col>
            {/* "Pick a time." stops being true the moment they have one
                (Aaron, 2026-09-05). Rendered from the SERVER's copy of the
                booking rather than swapped by CSS, so a family returning to
                their page never sees the wrong heading flash before hydration.
                BookingBlock calls router.refresh() after a booking or a
                cancel, which re-runs this and keeps it honest without a
                reload. */}
            <H2>
              <Accent text={bookedState ? b.booked?.heading || "You're all set." : b.heading} />
            </H2>

            {/* The static booked panel that lived here is GONE (2026-09-05).
                It said the same two lines BookingBlock's own booked panel says,
                minus the calendar buttons, the reschedule and the cancel, and
                the CSS path that swapped them in would have hidden the richer
                one to show the poorer one. BookingBlock owns the booked state
                outright now: it renders either the picker or the panel, and
                this file stops trying to render a third thing.

                The row's zoneNote is still deliberately unrendered: every chip
                and every day carries both clocks, so it restated the control. */}
            {!bookedState && (
              <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">{b.sub}</p>
            )}
          </Col>

          {/* The control takes the page's wide-figure exception at lg, the same
              one the tier cards take, because from 1024px it is two columns and
              a 38rem prose measure cannot hold a month grid beside a column of
              chips. Everything above it that is READ stays on the prose column
              with the rest of the page's text. */}
          <Wide>
            <BookingBlock
              slug={slug}
              initial={{ month, booked: bookedState }}
              copy={{
                booked: b.booked || { heading: 'Booked.', body: 'Nothing to prepare.' },
                /* For the add-to-calendar actions on the booked panel. The link
                   is already client-safe (lib/instructorPublic.js says so in its
                   first line) and is on this page anyway; passing it explicitly
                   keeps the client component from importing instructor config
                   just to build a URL. */
                zoomLink: instructor.zoomLink,
                calendarTitle: b.calendarTitle || `Conversation with ${instructor.fullName || instructor.displayName}`,
                confirmLabel: b.confirmLabel || 'Confirm this time',
                emptyLabel:
                  b.emptyLabel ||
                  "Ryan's calendar could not be loaded just now. Refresh the page, or email us and we will find a time.",
                /* What the family's own window is CALLED, for the one sentence
                   that has to name it ("No evenings are open in October").
                   Hard-coded as "mornings" until 2026-09-07, which was true
                   while every lead was fifteen hours ahead and Ryan's Pacific
                   afternoon landed in their morning. An Eastern-time family
                   books the same hours as their EVENING, and telling them no
                   mornings are open is a sentence about a window they were
                   never offered.

                   THE DEFAULT IS "times", NOT A GUESS AT THE WINDOW. A row that
                   says nothing gets the noun that is true on every clock, so
                   the sentence can never be false for a row nobody remembered
                   to annotate; a row that names its own window gets its own
                   word. Derived from the row rather than from the zone, because
                   the window is a choice about the family, not a fact about the
                   clock. */
                windowNoun: b.windowNoun || 'times',
              }}
            />
          </Wide>
        </section>
        )}

        {/* ── 6b. The one thing built for this family ─────────────────────────
            Present only when the row carries a `shortlist`, which today is
            Stella's alone. It sits HERE, directly under "what happens next" and
            well above the ask, because it is the evidence for the ask: the page
            has just told a family that Ryan puts things together himself, and
            this is him having already done it. Putting it after the CTA would
            make it a reward for saying yes; putting it before makes it the
            reason.

            The heading takes the prose column with every other heading on the
            page and the list takes the wide band, which is the same split the
            "what happens next" columns above it use. */}
        {lead.shortlist && Array.isArray(lead.shortlist.items) && (
          <>
            <Col className="mt-16" data-reveal>
              <H2>
                <Accent text={lead.shortlist.heading} />
              </H2>
              {lead.shortlist.lead && (
                <p className="mt-4 text-[17px] leading-relaxed text-ink-soft">
                  {lead.shortlist.lead}
                </p>
              )}
            </Col>
            <Wide className="mt-7" data-reveal>
              <Shortlist items={lead.shortlist.items} />
              {lead.shortlist.checked && (
                <p className="shortlist-checked">{lead.shortlist.checked}</p>
              )}
            </Wide>
          </>
        )}

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
        {/* RENDERED ONLY WHEN THERE ARE TIERS TO SHOW (2026-09-07, the same
            ruling that made `international` optional: the /next pages are
            modular, and a section is a claim about this family rather than a
            slot every row must fill). The block read `lead.packages.heading`,
            `.tiers.map` and `.notes.map` unguarded, so a row without a ladder
            crashed the route instead of dropping a section. Set `tiers` to []
            (or omit `packages`) and the heading, the cards and the notes are
            all simply not there; the "Want to learn more?" pamphlet chip below
            is a separate section and is unaffected. Rows that carry tiers,
            Conor's included, are untouched and still render. */}
        {lead.packages?.tiers?.length > 0 && (
        <section className="mt-20" data-reveal>
          <Col>
            <H2>
              <Accent text={lead.packages.heading} />
            </H2>
          </Col>

        <Wide className="mt-8" data-reveal>
          {/* THE GRID IS SIZED BY WHAT IS IN IT (2026-09-07, the senior shape).
              Three peer columns is the LADDER, which is what grades 9 to 11 get.
              A senior gets ONE number, custom-scoped (Claude_Lead Pages.md 2.4),
              and one card left in a three-column grid reads as two tiers that
              failed to load. One tier is a single card held to a card's width so
              it sits under the heading like a statement; two is two columns.
              A data change, not a page change: the three-tier case emits the
              exact class string it emitted before, so no live row moves.
              Full class names, never interpolated fragments: Tailwind reads this
              file as text and never sees a name it has to compute. */}
          <div
            className={
              lead.packages.tiers.length === 1
                ? 'grid gap-5 lg:max-w-[24rem] lg:gap-4'
                : lead.packages.tiers.length === 2
                  ? 'grid gap-5 lg:grid-cols-2 lg:gap-4'
                  : 'grid gap-5 lg:grid-cols-3 lg:gap-4'
            }
          >
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
                {/* `posture` OR `price` (2026-09-08). A LIGHT row carries no
                    figure, and the phrase that belongs in this slot is the
                    brochure's own posture word for the tier — "Structured",
                    "Bespoke", "By conversation". Writing that into a field
                    literally named `price`, on a page whose governing rule is
                    that no price appears, is a trap for whoever reads the row
                    next, so light rows use `posture` and priced rows keep
                    `price` untouched. Conor's live row is a `price` row and
                    does not move. */}
                <p
                  className={`mt-2 font-display font-normal text-ink ${
                    /\d/.test(tier.posture || tier.price || '')
                      ? 'text-[1.75rem] leading-none'
                      : 'text-[1.25rem] leading-snug'
                  }`}
                >
                  {tier.posture || tier.price}
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
        <Col className="mt-6" data-reveal>
          <div className="space-y-1 text-[14px] leading-relaxed text-ink-faint">
            {lead.packages.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        </Col>
        </section>
        )}

        {/* ── 7. Families outside the United States ───────────────────────────
            Every sentence is one the International Families pamphlet already
            prints. The pamphlet's own school-night clause is left out on
            purpose: it is true of a Saturday and false of a weekday.

            RENDERED ONLY FOR A FAMILY IT IS ABOUT (2026-09-07, the first
            domestic lead pages). Until now every row carried this block because
            the first lead was in Singapore, and the section read every field
            unguarded — `lead.international.stat` with no guard — so a row
            without the key crashed the route rather than dropping a section
            that does not apply. A family in Westchester does not need to be
            told that distance changes the calendar, and being told it is the
            page announcing that it was written for somebody else. Omit
            `international` (or set it null) and the whole section, the UK/US
            block included, is simply not there. Rows that carry it, Conor's
            included, are untouched and still render. */}
        {lead.international && (
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
        )}

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
              {/* `text-pretty` because this slot holds a QUOTATION whose text nobody
                  here controls: it is a student's own sentences, and the next
                  row will paste a different length again. Measured 2026-09-08 at
                  the 34rem measure, the previous excerpt broke 477 / 542 / 540 /
                  322, which is a notch at the top, two flush lines, then a stub,
                  and that is the "wrapped weirdly" Aaron saw. The replacement
                  excerpt breaks 502 / 518 / 488 / 472 on its own, so this is
                  insurance for the next quote rather than the fix for that one. */}
              <blockquote className="font-display text-[17px] italic leading-relaxed text-pretty text-ink">
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

        {/* ── 11. THE DOOR ───────────────────────────────────────────────────
            The light page's one action, and now the section that closes the
            argument (2026-09-08, Aaron via Clauni; moved back above the
            reading strip later the same day, on Aaron's word).

            It used to sit in the slot the calendar holds on a booking page,
            which put the ask third and asked a family to say yes before the
            page had shown them what they were saying yes to. A light page has
            no calendar and no price, so the only argument it can make is the
            material itself: what we heard, the work already done for this
            student, the ways a year runs, the brochures. The ask goes after
            all of it.

            A mailto and nothing else. No form, no endpoint, no state: the reply
            lands in Ryan's inbox where every other family conversation already
            lives, and a page that cannot collect an answer cannot mishandle
            one. Server-rendered, so no client component is added for it. */}
        {isLight && (
          <section className="mt-20" data-reveal>
            <Col>
              {/* THE HEADING NAMES THE STUDENT, because this page is one
                  family's and the ask should not read like a newsletter's. */}
              <H2>
                <Accent text={interest.heading || `Want to see options for ${lead.student}?`} />
              </H2>
              <p className="mt-4 text-[17px] leading-relaxed text-ink-soft">
                {interest.panel ||
                  `Say yes in one line and Ryan puts together two or three options built around what we heard, then emails them to you. No forms, nothing to prepare.`}
              </p>
              {/* ONE control and NOTHING UNDER IT (2026-09-08, Aaron: "remove
                  the bare, dangling ryan@ryanchoice.com"). The address was
                  printed here in plain text so a family reading mail in a
                  browser tab could still see where to write. It was the third
                  version of the same idea in three hours and it read as
                  leftover: an orphaned string under a button, pointing at the
                  address the button already opens. The footer carries both of
                  Ryan's addresses a screen further down, which is where a
                  contact detail belongs. */}
              <div className="cal-add">
                <a className="cal-add-btn" href={interestHref}>
                  {interest.buttonLabel || 'Send your questions'}
                </a>
              </div>
            </Col>
          </section>
        )}

        {/* ── 9b. Want to learn more? ─────────────────────────────────────────
            The documents, together, under a heading of their own (Aaron,
            2026-09-05). Both pamphlets used to sit as small ledes inside other
            sections: one under the price ladder, one under the international
            lines. That made each a footnote to whatever it happened to follow,
            and it made the question "is there more to read?" something a family
            could only answer by scrolling the whole page and noticing two
            chips in two different places.

            A first-class H2 answers it once. It also puts the two documents
            beside each other, which is where they belong: they are the same
            KIND of thing, and a family deciding whether to keep reading is
            choosing between them rather than stumbling on them one at a time.

            LAST BEFORE THE FOOTER on purpose. Everything above is what this
            family needs to book a conversation; this is what they take away if
            they want the longer version, so it sits at the end rather than
            interrupting the argument. Renders nothing at all when a lead has
            no documents switched on.

            WHAT MAY BE IN IT (2026-09-07, Ryan's round-one ruling): documents
            about the firm and the craft, never about the offer. A price-free
            guide is the page being generous; a fee-bearing pamphlet is the page
            selling, and round one does not sell. The list is per-family and is
            built above from `docs`; the guard below is its length, so a row
            with an empty list drops the heading with the chips rather than
            printing an invitation to read nothing. */}
        {docs.length > 0 && (
          <section className="mt-20" data-reveal>
            <Col>
              <H2>
                <Accent text={lead.docsHeading || 'Want to learn more?'} />
              </H2>
              <div className={docsHaveNotes ? 'doc-list' : 'doc-chips'}>
                {docs.map((d) => {
                  const ext = isExternal(d.href);
                  const chip = (
                    <a
                      key={d.href}
                      className={ext ? 'pdf-chip is-external' : 'pdf-chip'}
                      href={d.href}
                      {...(ext
                        ? { target: '_blank', rel: 'noopener' }
                        : { download: true })}
                    >
                      {d.label}
                    </a>
                  );
                  /* The un-noted case returns the chip ITSELF, with no wrapper,
                     so the chips stay DIRECT children of the flex row and the
                     markup a boolean-era row ships today is the markup it
                     keeps. */
                  return docsHaveNotes ? (
                    <div key={d.href} className="doc-list-item">
                      {chip}
                      {d.note && <p className="doc-note">{d.note}</p>}
                    </div>
                  ) : (
                    chip
                  );
                })}
              </div>
            </Col>
          </section>
        )}

        {/* ── 10. The footer ──────────────────────────────────────────────────
            The firm's contact block in the form the pamphlets print it. The en
            dash in the suite range is theirs; the hyphens in the phone number
            are a compound, not a range. */}
        <Col className="mt-20 pb-4" data-reveal>
          {/* SPACING REBUILT 2026-09-08 (Aaron: "the vertical padding for the
              footer is weird"). It was. Five lines carried four different gaps
              — name to firm 0.25rem, firm to address 0.75rem, then address to
              phone and phone to email at ZERO, because those two paragraphs had
              no margin at all. So the block opened loose and closed as a solid
              clump, and the address, the phone number and the email address ran
              together as though they were one wrapped line.

              Now it is two groups with one rhythm: who (name, firm) and where
              to reach him (address, phone, email), the second group set on a
              single `space-y` so every contact line gets the identical gap. The
              group separation is the only gap that is larger, which is what
              makes it read as a separation rather than as an accident. */}
          <div className="border-t border-ink-faint/25 pt-8 text-[14px] leading-relaxed text-ink-faint">
            <p className="font-display text-[1.05rem] font-semibold leading-snug text-ink-soft">
              {lead.footer.name}
            </p>
            <p className="mt-1.5">{lead.footer.firm}</p>
            <div className="mt-4 space-y-1.5">
              <p>{lead.footer.address}</p>
              <p>
                <a className="hover:text-terracotta-deep" href={`tel:+1${lead.footer.phone.replace(/\D/g, '')}`}>
                  {lead.footer.phone}
                </a>
              </p>
              {/* BOTH OF RYAN'S ADDRESSES, in the order the funnel meets them
                  (2026-09-08, Aaron): ryan@admissions.partners is what a lead
                  has been corresponding with, and ryan@ryanchoice.com is where
                  this page's own button writes. Printing only the second made
                  the page look like a different firm from the emails. The first
                  is an ALIAS of support@ rather than a mailbox Ryan watches, so
                  it is shown for continuity and is deliberately NOT what the
                  door opens; the door still writes to ryanchoice.com.
                  A row may carry `emails` (a list) or the older single `email`,
                  so Conor's live row renders exactly as it does today. */}
              <p className="flex flex-wrap items-center gap-x-2">
                {footerEmails.map((addr, i) => (
                  <span key={addr} className="flex items-center gap-x-2">
                    {i > 0 && <span aria-hidden="true">/</span>}
                    <a className="hover:text-terracotta-deep" href={`mailto:${addr}`}>
                      {addr}
                    </a>
                  </span>
                ))}
              </p>
            </div>
            {/* The International Families PDF link that lived here has MOVED
                into the international section itself, as a chip. A document
                filed next to a phone number is a document nobody decided a home
                for, and leaving a copy here as well would put the same link on
                the page twice in two different weights. */}
          </div>
        </Col>
      </main>

      {/* ── The sticky bar ──────────────────────────────────────────────────
          Reachable from the first screen on a phone, which is where this page
          is read. It is an anchor to the block above, not a second booking
          door: it moves the page, it does not open anything. Hidden once the
          family has booked, and hidden on desktop, where the whole page is a
          short scroll and a fixed bar over the content buys nothing. */}
      {/* Not rendered at all once the row holds a booking. `unbooked-only`
          alone was not enough: that class is driven by a data-booked attribute
          which, until 2026-09-05, was set ONLY by the ?booked=1 client flag, so
          a family returning to their own page was server-rendered as booked and
          still got a "Pick a time" bar pinned over their confirmation. Nothing
          had ever stayed booked before tonight, so nothing had ever shown it.
          The class stays for the client-side transitions BookingBlock drives. */}
      {/* A LIGHT PAGE HAS NO STICKY BAR, because it has nothing to jump to. The
          bar is an anchor to the calendar and the calendar is not on the page;
          left in, it would be a permanent "Pick a time" pinned over a page whose
          whole design is that no time is being offered yet. */}
      {!bookedState && !isLight && (
      <div className="sticky-book unbooked-only lg:hidden">
        <a href="#pick-a-time" className="sticky-book-btn">
          {b.stickyLabel}
        </a>
      </div>
      )}
    </>
  );
}
