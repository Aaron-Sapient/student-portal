import { DateTime } from 'luxon';
import { getGoogleCalendarClient } from '@/lib/google';
import { getInstructor, validateInstructorHours } from '@/lib/instructors';
import { verifySlotStillFree } from '@/lib/bookingSlots';
import { buildEventTitle } from '@/lib/calendarTitles';
import { sendBookingEmail } from '@/lib/bookingEmail';
import { describeSlot, inFamilyMorning, NEXT_DURATION_MINUTES } from '@/lib/nextBooking';
import { getLead, maskEmail, recordLeadBooking } from '@/app/next/[slug]/leads';

/* POST /api/next/book  { slug, start, dryRun? }
   ─────────────────────────────────────────────────────────────────────────
   Books the second conversation on Ryan's real calendar, from a page the family
   reached with no account. The slug is the credential, same as the page and the
   slots endpoint.

   ⚠ THIS LANE HAS NEVER RUN THIS ROUTE FOR REAL. The development environment's
   GOOGLE_CALENDAR_ID_RYAN points at Ryan's production calendar, so every
   exercise of this route from the build lane was `dryRun: true`, which computes
   and validates everything and returns the exact event body it WOULD insert
   without touching Google, Supabase or SMTP. The first real write is Aaron's to
   make.

   THE ORDER OF OPERATIONS, and why it is this order:

     1. re-verify the slot live. The page was rendered at some earlier moment and
        availability is only true at the instant it is computed. This calls the
        SAME function that produced the offer (lib/bookingSlots), so the offer
        and the gate cannot disagree by construction.
     2. insert the new event.
     3. record it on the lead row.
     4. cancel the OLD event, if this is a reschedule.
     5. notify support@.

   Steps 2 before 4 is deliberate. Cancel-then-book leaves a family with nothing
   at all if the insert fails; book-then-cancel leaves, at worst, one stale event
   on Ryan's calendar that a human can delete. The failure that costs a family
   their meeting is the one worth designing against.

   IDEMPOTENT UNDER RETRIES: a second POST naming the SAME start as the row
   already holds returns the existing booking and writes nothing. Only a
   different start is treated as a reschedule. A double-tapped confirm button,
   or a retried request behind a dropped connection, therefore cannot produce
   two events. */

export const dynamic = 'force-dynamic';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }

  const { slug, start, dryRun = false } = body || {};
  if (!slug || !start) return Response.json({ error: 'Missing slug or start' }, { status: 400 });

  const lead = await getLead(slug);
  if (!lead) return Response.json({ error: 'Not found' }, { status: 404 });

  const b = lead.booking || {};
  const instructor = getInstructor(b.instructor || 'ryan');
  const duration = b.durationMinutes || NEXT_DURATION_MINUTES;
  const durationLabel = `${duration}min`;
  const timezone = b.timezone || 'Asia/Singapore';
  const zoneLabel = b.zoneLabel || 'Singapore time';

  const startTime = DateTime.fromISO(start).setZone('America/Los_Angeles');
  if (!startTime.isValid) return Response.json({ error: 'Bad start time' }, { status: 400 });
  const endTime = startTime.plus({ minutes: duration });

  /* Already booked at exactly this time: the answer is the booking, not a second
     one. This is the whole of the retry guard and it runs before any network
     call, so a hammered confirm button costs nothing. */
  const existing = lead.booked || null;
  if (existing?.event_id && existing.start === startTime.toISO()) {
    return Response.json({ ok: true, unchanged: true, booked: bookedPayload(existing, b, timezone, zoneLabel) });
  }

  /* The family's own morning window, re-checked server-side. The UI only ever
     offers slots inside it, so failing here means the start did not come from
     the page. */
  if (!inFamilyMorning({ start: startTime.toISO(), end: endTime.toISO() }, timezone, b.morning)) {
    return Response.json({ error: 'That time is outside the window we offer.' }, { status: 400 });
  }

  /* Ryan's standing hours, including the end-by-close check that a start-hour
     test alone would let overrun. */
  const hoursError = validateInstructorHours(instructor, startTime, duration);
  if (hoursError) return Response.json({ error: hoursError }, { status: 409 });

  try {
    const calendar = getGoogleCalendarClient(slug);

    /* Live re-validation against blocks, busy time and the teaching-run cap. On a
       reschedule the event being MOVED must not block its own replacement. */
    const stillFree = await verifySlotStillFree({
      calendar,
      instructor,
      startISO: startTime.toISO(),
      duration,
      earliestAllowed: DateTime.now().setZone('America/Los_Angeles').plus({ days: 1 }),
      replacingEventId: existing?.event_id || null,
    });
    if (stillFree) return Response.json({ error: stillFree }, { status: 409 });

    /* The calendar title uses the family's FILING handle ("Conor Min"), not the
       page's greeting name. The title is internal: it is what Ryan reads in his
       own day and what lib/calendarTitles' matching rules and the omnibar key
       off. The page addresses the student as they asked to be addressed; the
       calendar names the household Ryan filed them under. */
    /* A rehearsal books the real calendar and sends the real invitation, which
       is the whole point: Aaron needs to see what the Mins will see. What it
       must NOT do is reach anyone who would act on it, so the title says what
       it is on Ryan's own screen and support@ is not told (below). */
    const eventTitle = buildEventTitle({
      studentName: b.calendarName || lead.student,
      duration: durationLabel,
      agenda: b.agenda || 'Second conversation',
      prefix: lead.rehearsal ? 'REHEARSAL: ' : '',
    });
    const eventDescription = `Zoom: ${instructor.zoomLink}\nAgenda: ${b.agenda || 'Second conversation'}`;

    const requestBody = {
      summary: eventTitle,
      description: eventDescription,
      start: { dateTime: startTime.toISO(), timeZone: 'America/Los_Angeles' },
      end: { dateTime: endTime.toISO(), timeZone: 'America/Los_Angeles' },
      /* NO ATTENDEES, deliberately (2026-09-04). This asked Google to invite the
         family directly, and Google refused every time:

           Service accounts cannot invite attendees without Domain-Wide
           Delegation of Authority.

         DWD is Workspace-admin state on the tenant that owns ryanchoice.com,
         and Aaron does not hold that console — so the fix is not a fix Aaron can
         apply, and a $50,000 lead was about to wait a weekend on somebody else's
         admin panel for what amounts to a nicety. The invitation was never the
         deliverable; the MEETING is. The family gets the time, the date and the
         Zoom link by email through lib/bookingEmail.js, which is exactly how
         every student booking in this portal has worked for a year — bookMeeting
         sends no attendees either, which is why it has never needed delegation.

         What the family loses: a calendar entry that appears by itself, and an
         RSVP. What they get instead: an email they have to add manually. That is
         the whole gap, and it is worth reopening ONLY as an upgrade once someone
         with admin on ryanchoice.com can authorize this service account's client
         id for the calendar scope. Restore this line and the four sendUpdates
         below together, or the invitation goes out silently to nobody. */
      extendedProperties: {
        private: {
          source: 'student-portal',
          bookingType: 'lead-next',
          /* ATTRIBUTION. The booking carries the lead slug natively, on the
             event and on the row, which is why there are no UTM parameters
             anywhere in this flow any more: the question "where did this
             booking come from" is answered by data we own rather than by a
             query string a third party may or may not have preserved. */
          leadSlug: slug,
          leadId: lead.id || '',
          instructor: instructor.slug,
          type: durationLabel,
        },
      },
    };

    if (dryRun) {
      return Response.json({
        ok: true,
        dryRun: true,
        wouldInsert: {
          calendarId: instructor.calendarId,
          sendUpdates: 'none',
          requestBody,
        },
        wouldCancelEventId: existing?.event_id || null,
        wouldEmail: lead.rehearsal
          ? { to: [b.familyEmail], note: 'rehearsal: family only, support@ NOT notified', via: 'lib/bookingEmail.sendBookingEmail' }
          : { to: [b.familyEmail, instructor.bookingEmail].filter(Boolean), via: 'lib/bookingEmail.sendBookingEmail' },
        wouldRecordOn: `lead_pages.${slug}`,
        booked: bookedPayload(
          { start: startTime.toISO(), event_id: '(dry run: no event created)', booked_at: DateTime.now().toISO() },
          b, timezone, zoneLabel
        ),
      });
    }

    // 2. Insert. sendUpdates is 'none' because there are no attendees left to
    //    notify — see the requestBody comment above. The family is told by
    //    email in step 5, not by Google.
    const eventRes = await calendar.events.insert({
      calendarId: instructor.calendarId,
      sendUpdates: 'none',
      requestBody,
    });

    const booking = {
      event_id: eventRes.data.id,
      start: startTime.toISO(),
      booked_at: DateTime.now().toISO(),
    };

    // 3. Record on the row. If this fails, roll the event back rather than leave
    //    a meeting on Ryan's calendar that no page knows about.
    try {
      await recordLeadBooking(slug, booking);
    } catch (rowErr) {
      console.error(`lead_pages write failed for ${slug} — rolling back event:`, rowErr);
      try {
        await calendar.events.delete({
          calendarId: instructor.calendarId,
          eventId: eventRes.data.id,
          sendUpdates: 'none',
        });
      } catch (delErr) {
        console.error('Failed to roll back orphaned event:', delErr);
      }
      return Response.json({ error: 'Booking could not be recorded. Please try again.' }, { status: 500 });
    }

    // 4. Reschedule: retire the old event now that the new one is safely in.
    let staleEventId = null;
    if (existing?.event_id) {
      try {
        await calendar.events.delete({
          calendarId: instructor.calendarId,
          eventId: existing.event_id,
          sendUpdates: 'none',
        });
      } catch (cancelErr) {
        // The family's booking is correct and recorded; what is left is one
        // stale event on Ryan's calendar that a human has to remove. Surfaced
        // rather than swallowed, because nothing else will notice it.
        console.error(`Could not cancel previous event ${existing.event_id} for ${slug}:`, cancelErr);
        staleEventId = existing.event_id;
      }
    }

    // 5. support@ hears about it in exactly the shape a student booking sends,
    //    UNLESS this is a rehearsal: the invitation still goes to the attendee
    //    (receiving it is the exercise), but nobody on the team should be told a
    //    family booked when no family did.
    /* A rehearsal now SENDS, where it used to stay silent. That silence was
       correct only while Google delivered the invitation: receiving it was the
       whole exercise, so the mail would have been a second copy and support@
       would have been told a family booked when none had. With the invitation
       gone the mail is the ONLY signal there is, and a rehearsal that notifies
       nobody proves nothing.
       support@ still stays out of it, by handing sendBookingEmail an instructor
       with no booking address rather than by branching around the call — the
       helper already drops empty recipients, and it is shared with the portal's
       own booking route, so it is not the place to teach about rehearsals. */
    try {
      await sendBookingEmail(
        lead.rehearsal ? { ...instructor, bookingEmail: null, cancelEmail: null } : instructor,
        b.calendarName || lead.student,
        b.familyEmail,
        durationLabel,
        startTime.toISO(),
        b.agenda || 'Second conversation',
        Boolean(existing?.event_id)
      );
    } catch (mailErr) {
      // A failed notification must never fail a confirmed booking. The meeting
      // is on the calendar and the family has their invitation.
      console.error(`Booking notification failed for ${slug}:`, mailErr);
    }

    return Response.json({
      ok: true,
      rescheduled: Boolean(existing?.event_id),
      ...(staleEventId ? { staleEventId } : {}),
      booked: bookedPayload(booking, b, timezone, zoneLabel),
    });
  } catch (err) {
    console.error(`/api/next/book failed for ${slug}:`, err);
    return Response.json({ error: 'That booking could not be completed.' }, { status: 500 });
  }
}

/* What the page needs to render the booked state: the time on both clocks and
   the address the invitation went to. No event id — the family has no use for
   it and it is the one field that would let a leaked response be acted on. */
function bookedPayload(booking, b, timezone, zoneLabel) {
  const duration = b.durationMinutes || NEXT_DURATION_MINUTES;
  const slot = describeSlot(
    { start: booking.start, end: DateTime.fromISO(booking.start).plus({ minutes: duration }).toISO() },
    timezone,
    zoneLabel
  );
  /* Masked. With a first-name slug the booked state is reachable by anyone who
     guesses the child's name, and a full address there would be the one piece of
     contact data the page hands out. Enough survives for the family to confirm
     the invitation went to the right inbox, which is all this line is for. */
  return { start: booking.start, email: maskEmail(b.familyEmail), slot };
}
