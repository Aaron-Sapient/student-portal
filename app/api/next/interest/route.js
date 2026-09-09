import { getLead } from '@/app/next/[slug]/leads';
import { sendAutonomousEmail } from '@/lib/autonomousEmail';

/* POST /api/next/interest   { slug }
   ─────────────────────────────────────────────────────────────────────────
   A family saying yes, from the light page's own button rather than from their
   mail client.

   WHY THIS EXISTS AT ALL. The light page's whole job is to gauge interest, and
   until now its one control was a `mailto`. A mailto is fine for a family who
   wants to type something; it is a wall for a family whose answer is simply
   "yes, do it", because it hands them an empty compose window and asks them to
   find the words. Ryan's read of these leads, in his words, is "the longer and
   heavier, the better. they love it" — so the fork is between a family who
   wants to TALK (that one still writes, and the second button is still a
   mailto) and a family who wants to BUY, who should be one tap from saying so.

   NO CLERK, and no Clerk is possible: a lead has no account and will never have
   one. The slug is the credential, exactly as it is for the page this button
   sits on and for /api/next/slots beside it.

   WHAT IT REFUSES. An unknown slug is a plain 404 with no hint the address
   space exists, so this cannot enumerate leads. A closed row is the same 404: a
   family who has already signed does not need to ask for packages, and the
   difference between "no such lead" and "that lead is done" is a fact about
   somebody else's family.

   THE MAIL GOES TO A PERSON, DELIBERATELY, which is the one place this route
   departs from `sendAutonomousEmail`'s usual posture. That helper exists so
   automated nudges never land in a counselor's personal inbox; here the whole
   payload IS a person asking Ryan for something, and Ryan's watched mailbox is
   where every other family conversation already lives. support@ is CC'd so the
   shared inbox has it too, and so an automation has one place to watch. The
   From stays the noreply sender and the Reply-To stays support@, so a reply to
   this notification cannot start a thread the family is not part of.

   THE BODY IS MACHINE-READABLE ON PURPOSE (Aaron: "something that the
   automations can easily pick up"). A stable marker line, then `key: value`
   pairs, one per line, lowercase keys, no wrapping. A human reads the sentence
   at the top; a script greps LEAD_INTEREST and splits on the first colon. */

export const dynamic = 'force-dynamic';

const RYAN = process.env.LEAD_INTEREST_TO || 'ryan@ryanchoice.com';
const SHARED = process.env.LEAD_INTEREST_CC || 'support@admissions.partners';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }

  const slug = typeof body?.slug === 'string' ? body.slug : '';
  /* WHICH TIER THE FAMILY PRESSED (2026-09-08). A heavy page shows the offer
     Ryan actually made, so its door can name a tier where the light page could
     only ask for options.

     ALLOWLISTED, NOT ECHOED, and that matters more here than it looks. Every
     other field below is read off the ROW precisely so a caller cannot put
     words in a family's mouth, and accepting free text from the request would
     be the one hole in that. An unrecognised value is dropped rather than
     rejected: the family's yes must still reach Ryan even if the page sends
     something this route has not learned about yet. */
  const CHOICES = { comprehensive: 'Comprehensive', vip: 'VIP', uvip: 'Ultra VIP' };
  const choice = CHOICES[body?.choice] ? body.choice : '';
  /* Shape-checked before it reaches the database, and it is the same shape the
     seed script enforces when it writes a row. */
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const lead = await getLead(slug);
  if (!lead || lead.status === 'closed') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const student = lead.student || slug;
  const page = `https://book.ryanchoice.com/${slug}`;
  /* Everything below is read off the row rather than off the request. The
     request carries a slug and nothing else, so a caller cannot put words in a
     family's mouth or address the notification somewhere new. */
  const fields = [
    ['slug', slug],
    ['student', student],
    ['household', lead.recipientName || ''],
    ['family_email', lead.booking?.familyEmail || ''],
    ['mode', lead.mode || 'heavy'],
    ['action', choice ? 'chose_package' : 'build_custom_packages'],
    ['choice', choice],
    ['choice_label', choice ? CHOICES[choice] : ''],
    ['page', page],
    ['requested_at', new Date().toISOString()],
  ];

  const text =
    (choice
      ? `${student}'s family chose ${CHOICES[choice]} on their page.\n\n`
      : `${student}'s family asked for custom packages from their page.\n\n`) +
    `LEAD_INTEREST\n` +
    fields.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n`;

  try {
    await sendAutonomousEmail({
      to: RYAN,
      cc: [SHARED],
      subject: choice
        ? `[LEAD INTEREST] ${student} chose ${CHOICES[choice]}`
        : `[LEAD INTEREST] ${student} asked for custom packages`,
      text,
    });
  } catch (err) {
    /* The family is told plainly, and given the address, rather than shown a
       success they did not get. A button that says "sent" over a failed send is
       the worst outcome available here: they stop waiting for an answer nobody
       knows to send. */
    console.error('[next/interest] send failed', slug, err?.message);
    return Response.json({ error: 'Send failed' }, { status: 502 });
  }

  return Response.json({ ok: true });
}
