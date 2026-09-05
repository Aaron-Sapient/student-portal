import { google } from 'googleapis';
import { getInstructor } from '@/lib/instructors';
import { getLead, clearLeadBooking } from '@/app/next/[slug]/leads';

/* POST /api/next/cancel  { slug }

   The family cancelling their own second conversation, from the booked panel on
   their page. Until now the only way to undo a lead booking was
   scripts/cancelNextBooking.mjs, which is Aaron at a terminal, so a family who
   could no longer make it had no move except to email somebody.

   SAME CREDENTIAL AS BOOKING, deliberately, and worth saying out loud because
   it looks alarming: possession of the slug is the whole authorisation, and
   slugs are first names now. That grants no capability booking did not already
   grant. Confirming a time on a page that already holds a booking RESCHEDULES
   it, which retires the existing event either way, so anyone who could reach
   this route could already have moved the meeting. Cancelling is the same power
   with a plainer name, and the row keeps who did what through booked_at.

   Clears the row LAST, after Google has accepted the delete, so a failure
   leaves a bookable page pointing at a real event rather than a cleared page
   pointing at a meeting nobody can see. */
function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Bad request.' }, { status: 400 });
  }
  const { slug } = body || {};
  if (!slug || typeof slug !== 'string') {
    return Response.json({ error: 'Bad request.' }, { status: 400 });
  }

  const lead = await getLead(slug);
  if (!lead || lead.status === 'closed') {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }

  const booking = lead.booked;
  /* Already cancelled, or never booked. Answering OK rather than 404 is
     deliberate: the caller asked for a page with no booking on it and that is
     what they have, and a second tap on a slow connection must not read as a
     failure. */
  if (!booking?.event_id) return Response.json({ ok: true, alreadyClear: true });

  const instructor = getInstructor(lead.booking?.instructor);
  try {
    const calendar = google.calendar({ version: 'v3', auth: getServiceAuth() });
    await calendar.events.delete({
      calendarId: instructor.calendarId,
      eventId: booking.event_id,
      /* No attendees on these events (see /api/next/book), so there is nobody
         for Google to notify. */
      sendUpdates: 'none',
    });
  } catch (err) {
    const code = err?.code || err?.response?.status;
    /* 410/404 mean Google already considers it gone, which IS the end state
       being asked for, so the row still gets cleared rather than left pointing
       at an event that does not exist. */
    if (code !== 410 && code !== 404) {
      console.error(`/api/next/cancel: calendar delete failed for ${slug}:`, err.message);
      return Response.json({ error: 'That could not be cancelled. Please try again.' }, { status: 500 });
    }
  }

  try {
    await clearLeadBooking(slug);
  } catch (rowErr) {
    console.error(`/api/next/cancel: row clear failed for ${slug}:`, rowErr.message);
    return Response.json({ error: 'That could not be cancelled. Please try again.' }, { status: 500 });
  }

  return Response.json({ ok: true });
}
