import { getGoogleCalendarClient } from '@/lib/google';
import { getLead } from '@/app/next/[slug]/leads';
import { nextAvailability } from '@/lib/nextBooking';

/* GET /api/next/slots?slug=<lead-slug>
   ─────────────────────────────────────────────────────────────────────────
   Real openings on Ryan's calendar for one lead's page, in the family's own
   morning and on both clocks.

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

  const lead = await getLead(slug);
  if (!lead) return Response.json({ error: 'Not found' }, { status: 404 });

  try {
    /* The app's own calendar client, keyed per lead so this route draws on its
       own slice of Google's per-principal rate quota instead of sharing the
       students' bucket. */
    const calendar = getGoogleCalendarClient(slug);
    const result = await nextAvailability({ calendar, lead });
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
