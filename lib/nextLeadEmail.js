import nodemailer from 'nodemailer';

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
  subject: 'Your conversation with {instructor} is confirmed',
  rescheduleSubject: 'Your conversation with {instructor} has moved',
  /* "Hi," and not "Hi {student}," on purpose. The PAGE is addressed to the
     student; this email goes to whatever address the family gave, which is
     usually a parent. Greeting a parent by their child's name is the kind of
     small wrongness that tells a family they are reading a form letter. A row
     that knows who reads the inbox can say so. */
  greeting: 'Hi,',
  lead: 'You are booked with {instructor} for {familyDay} {familyTime} {familyZone}.',
  secondLine: 'That is {pacificDay} {pacificTime} in Irvine.',
  duration: 'It is a {durationAdj} conversation on Zoom.',
  zoomLabel: 'Zoom link:',
  rescheduleNote: 'If you need a different time, you can pick another one on your page:',
  signoff: '{instructor}\nAdmissions Partners',
};

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
  return {
    student: lead.student || '',
    instructor: signer,
    instructorShort: instructor.displayName,
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
    fill(copy.greeting, tokens),
    [fill(copy.lead, tokens), fill(copy.secondLine, tokens)].filter(Boolean).join(' '),
    fill(copy.duration, tokens),
    [fill(copy.zoomLabel, tokens), instructor.zoomLink].filter(Boolean).join('\n'),
    pageUrl ? [fill(copy.rescheduleNote, tokens), pageUrl].filter(Boolean).join('\n') : '',
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
