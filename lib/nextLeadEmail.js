import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';

/* The family's confirmation for a /next/<slug> booking.
   ─────────────────────────────────────────────────────────────────────────
   WHY THIS IS NOT lib/bookingEmail.js. That file writes to an OPERATIONS
   inbox: "Conor Min has booked a 30min meeting with Ryan Choi for Tuesday,
   September 8 at 4:30 PM (Pacific Time). This is an automated message from the
   student portal." Correct for support@, wrong for a family in three separate
   ways. It talks ABOUT them in the third person. It gives Pacific time only, to
   a household on the other side of the world, on a page whose entire booking
   design is showing both clocks on every chip and on the confirm sentence. And
   it signs off as a portal they have no account on and never will.

   None of that mattered while Google delivered the real invitation and this was
   chatter alongside it. Dropping attendees (see app/api/next/book/route.js) made
   it the ONLY thing the family receives, and a notification that has been
   promoted from secondary to primary has to be re-read in its new role.

   bookingEmail.js is deliberately untouched: the portal's own booking route
   shares it, and support@ should keep receiving exactly the shape it already
   reads. A lead booking now sends TWO mails, one per audience, instead of one
   mail wearing the wrong voice for one of them.

   PLUG AND PLAY, which is the point of the shape below rather than a nicety.
   This page paradigm is meant to serve every future lead, so a new family must
   be a row and nothing else. Every line of copy has a default here; a lead row
   may override any subset through `confirmEmail` and inherits the rest. A row
   that says nothing gets a correct email. A row that needs one line different
   changes one line, not a template.

   Times come from describeSlot, the SAME function that renders the page's
   confirm sentence, so the email and the page cannot disagree about when the
   meeting is. That is the same rule the availability engine follows: one
   implementation, two surfaces. */

/* Copy. Tokens in braces, resolved by fill() below; an unknown token is left
   alone rather than blanked, so a typo in a row is visible in the draft instead
   of silently deleting a sentence.

   No em dashes anywhere in here: this is outward-facing prose. */
export const CONFIRM_DEFAULTS = {
  subject: "We're on for {familyDay} at {familyTime}",
  rescheduleSubject: "Your new time with {instructor}: {familyDay} at {familyTime}",
  /* {recipient} is the PARENT, typed in by hand from the consult transcript
     (see the recipient note below). With no name on the row this resolves to a
     bare "Hi," rather than to the student's name: the page is addressed to the
     student, the inbox belongs to a parent, and greeting a parent by their
     child's name is precisely how a form letter announces itself. */
  greeting: 'Hi {recipient},',
  opening:
    "We're all set for {familyDateLong} at {familyTime} {familyZone}, and I've put aside {durationWords} for us.",
  zoom: "We'll talk in my usual Zoom room:",
  reschedule:
    "If something shifts on your end, you can pick a different time straight from {student}'s page and it'll update on my side automatically.",
  closing: 'Looking forward to it.',
  signoff: '{instructor}\nAdmissions Partners',
};

/* ONLY THE READER'S OWN CLOCK (Aaron, 2026-09-05). The page shows both, and has
   to: choosing a time across a twelve-hour gap is a decision you cannot make
   without seeing both ends of it. The email confirms a decision already made,
   and a parent in Singapore has no use for what time it is in Irvine. The
   pacific tokens still exist for a row that wants them; the default copy simply
   does not reach for them.

   THE ZOOM LINK IS RYAN'S STANDING ROOM, not a per-meeting join code: every
   booking through the portal's API routes to the same address. So the copy says
   "my usual Zoom room" instead of presenting it as something minted for this
   conversation, which is both true and warmer than a bare "Zoom link:" label.

   ON THE VOICE. This is the first written thing a family receives from the
   firm, and it has to read as though Ryan typed it. That is a different
   register from everything else this repo emits: contractions, sentences that
   run on past one idea when the idea has a second half, warmth carried in the
   verbs rather than added as a closing pleasantry. The first draft of this said
   "It is a 30-minute conversation on Zoom", which is accurate, correctly
   punctuated, and reads like a receipt. No em dashes: outward-facing prose. */
/* NO NAME MEANS NO SALUTATION AT ALL (Aaron, 2026-09-05), not a bare "Hi,".
   Both of the obvious fallbacks are worse than nothing. "Hi ," is a mail-merge
   confessing that a cell was empty, and a naked "Hi," is the sound of a letter
   addressed to whoever opens it, which is exactly the impression this email
   exists to avoid. Dropping the line entirely just opens on the news, and
   "We're all set for Wednesday 9 September" is a perfectly good first sentence
   for something a person actually typed. */
function recipientGreeting(copy, tokens) {
  if (!tokens.recipient) return '';
  return fill(copy.greeting, tokens);
}

function fill(template, tokens) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key] ?? '') : whole
  );
}

/* The tokens a row's copy may use. Everything the page knows about the booking,
   named the way a writer would reach for it. */
export function confirmTokens({ lead, instructor, slot, durationLabel, pageUrl }) {
  /* Who signs. A row may name someone else outright, which is what makes this
     paradigm reusable for a lead another counsellor is handling; otherwise the
     instructor's family-facing full name, falling back to the in-product short
     name so a new instructor without one still renders a sentence. */
  const signer =
    lead.confirmEmail?.instructorName || instructor.fullName || instructor.displayName;
  /* THE PARENT'S NAME IS TYPED IN, NOT DERIVED (Aaron, 2026-09-05).
     Generating a lead page now requires the initial consultation transcript, so
     a human has already read the call before this email can exist, and pulling
     the parent's name out of it is one line of that same pass. This works the
     way the go.ryanchoice.com CTA guides work: Claude plugs the specifics in
     each time. Trying to make it end-to-end programmatic would be inventing a
     machine to recover something a person already has in front of them, and
     diarised speaker labels are exactly the kind of source that will confidently
     hand back the wrong name.
     Conor's row is the case that proves the point: his mother introduces herself
     on the call as "his mom" and is never named, and "Min" is only what went
     into Calendly. So it stays empty there, and the greeting degrades to "Hi,"
     rather than guessing. */
  const recipient = lead.recipientName || '';
  return {
    recipient,
    student: lead.student || '',
    instructor: signer,
    instructorShort: instructor.displayName,
    /* "Wednesday 9 September". A day name alone is thin for something a week
       out, and a family should not have to count forward to know which
       Wednesday. Built from the family's own date, so it is their Wednesday. */
    familyDateLong: `${slot.family.day} ${DateTime.fromISO(slot.family.date).toFormat('d LLLL')}`,
    familyDay: slot.family.day,
    familyTime: slot.family.time,
    familyDate: slot.family.date,
    familyZone: slot.family.zone,
    familyAbbr: slot.family.abbr,
    pacificDay: slot.pacific.day,
    pacificTime: slot.pacific.time,
    familyLabel: slot.label,
    pacificLabel: slot.subLabel,
    duration: durationLabel,
    /* "30min" is a product label and reads like one in a sentence. Families get
       words, in BOTH grammatical shapes, because a single form cannot serve
       both slots a writer needs: `durationWords` is the noun phrase ("30
       minutes", as in "it runs 30 minutes") and `durationAdj` is the
       attributive ("30-minute", as in "a 30-minute conversation"), hyphenated
       because a compound modifier before a noun takes one. Anything that is not
       <number>min passes through untouched in both, so an unusual label
       degrades to itself rather than to nonsense. */
    durationWords: /^\d+min$/.test(String(durationLabel))
      ? `${parseInt(durationLabel, 10)} minutes`
      : String(durationLabel ?? ''),
    durationAdj: /^\d+min$/.test(String(durationLabel))
      ? `${parseInt(durationLabel, 10)}-minute`
      : String(durationLabel ?? ''),
    zoom: instructor.zoomLink,
    pageUrl,
  };
}

/* Render without sending, so a draft can be read before a family ever gets one.
   The dry-run branch of the book route returns this verbatim, which makes
   `dryRun: true` the way to proof a new lead's email. */
export function renderConfirmation({ lead, instructor, slot, durationLabel, pageUrl, isReschedule = false }) {
  const copy = { ...CONFIRM_DEFAULTS, ...(lead.confirmEmail || {}) };
  const tokens = confirmTokens({ lead, instructor, slot, durationLabel, pageUrl });

  const subject = fill(isReschedule ? copy.rescheduleSubject : copy.subject, tokens);

  /* Built as blocks and joined, so a row can blank ONE line by setting it to ''
     without leaving a hole where it was. */
  const blocks = [
    /* A row with no parent name gets "Hi," and not a dangling comma. */
    recipientGreeting(copy, tokens),
    fill(copy.opening, tokens),
    [fill(copy.zoom, tokens), instructor.zoomLink].filter(Boolean).join('\n'),
    pageUrl ? [fill(copy.reschedule, tokens), pageUrl].filter(Boolean).join('\n') : '',
    fill(copy.closing, tokens),
    fill(copy.signoff, tokens),
  ].filter((b) => b && b.trim());

  return {
    to: lead.booking?.familyEmail || '',
    /* A rehearsal books Ryan's real calendar and sends a real mail. The pill on
       the page is the only thing marking it there; this is the only thing
       marking it in an inbox, and without it Aaron receives something
       indistinguishable from a real family's confirmation. */
    subject: lead.rehearsal ? `REHEARSAL: ${subject}` : subject,
    text: blocks.join('\n\n'),
  };
}

export async function sendConfirmation(args) {
  const mail = renderConfirmation(args);
  if (!mail.to) return { skipped: 'no family email on the row' };

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
  });
  return { sent: mail.to, subject: mail.subject };
}
