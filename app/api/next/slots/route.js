import { getGoogleCalendarClient } from '@/lib/google';
import { getLead, isBookable } from '@/app/next/[slug]/leads';
import { monthAvailability } from '@/lib/nextBooking';

/* GET /api/next/slots?slug=<lead-slug>[&month=yyyy-MM]
   ─────────────────────────────────────────────────────────────────────────
   Real openings on Ryan's calendar for one lead's page, in the family's own
   morning and on both clocks, one calendar month at a time in the FAMILY's
   zone. No month means the family's current month, or the next one when the
   current month has nothing left. The month grid on the page pages through
   this one month per tap.

   NO CLERK. The slug is the credential, exactly as it is for the page it feeds
   and for /write and /proposal before it: a family has no account and will
   never have one, and the unguessable <lead>-<6 hex> is what authorizes them.
   An unknown slug is a plain 404 with no hint that the address space exists,
   which also means this endpoint cannot be used to enumerate leads.

   It answers with availability and nothing else. No name, no email, no price:
   a slug that leaks should cost a family their calendar privacy at worst, not
   their contact details. */

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const slug = searchParams.get('slug');
  if (!slug) return Response.json({ error: 'Missing slug' }, { status: 400 });

  /* The family's month, `yyyy-MM`, or nothing for the page's default. Shape-
     checked here so a stray value never reaches the date library. */
  const month = searchParams.get('month') || 'auto';
  if (month !== 'auto' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return Response.json({ error: 'Bad month' }, { status: 400 });
  }

  const lead = await getLead(slug);
  if (!lead) return Response.json({ error: 'Not found' }, { status: 404 });

  /* A row that is not bookable has no availability to give (leads.js explains
     which rows those are and why). 404 rather than 403, and with the same body
     an unknown slug gets: telling a caller that this address exists but is not
     offering times is a fact about a family, and this endpoint's whole design is
     that it answers with availability or with nothing. The page never calls this
     for such a row anyway; the guard is here for everyone who is not the page. */
  if (!isBookable(lead)) return Response.json({ error: 'Not found' }, { status: 404 });

  try {
    /* The app's own calendar client, keyed per lead so this route draws on its
       own slice of Google's per-principal rate quota instead of sharing the
       students' bucket. */
    const calendar = getGoogleCalendarClient(slug);
    const result = await monthAvailability({ calendar, lead, month });
    if (result.error) return Response.json(result, { status: 400 });
    return Response.json(result, {
      // Availability is only true at the instant it is computed, and this page
      // is one a family may leave open in a tab for an hour. Never cache it.
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error(`/api/next/slots failed for ${slug}:`, err);
    return Response.json({ error: 'Could not load times.' }, { status: 500 });
  }
}
