import { google } from 'googleapis';
import { requireDeveloper } from '@/lib/developerAuth';
import { getInstructor } from '@/lib/instructors';
import { sendStudentCancellationEmail } from '@/lib/studentEmails';
import { cancelBookingByEventId, cancelOneoffByEventId } from '@/lib/seniors';
import { cancelProjectBookingByEventId } from '@/lib/projectMeetings';
import { cancelStandardBookingByEventId } from '@/lib/bookings';
import { setBookingToken } from '@/lib/bookingTokens';
import { getStudentByEmail } from '@/lib/identity';

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
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const { eventId, instructor: instructorSlug, studentEmail, studentName, meetingStart, duration } = await request.json();
    if (!eventId || !instructorSlug) {
      return Response.json({ error: 'Missing eventId or instructor' }, { status: 400 });
    }

    const instructor = getInstructor(instructorSlug);
    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    await calendar.events.delete({ calendarId: instructor.calendarId, eventId });

    // Return any senior token tied to this event — weekly grant OR one-off track
    // (both no-op for non-matching events). Project meetings free their own 1/week
    // ledger row; wasProject then skips the standard Master-token restore below.
    await cancelBookingByEventId(eventId);
    await cancelOneoffByEventId(eventId);
    const wasProject = await cancelProjectBookingByEventId(eventId);

    // The standard/ART RECORD (Supabase `bookings`) — the fourth ledger, and the one
    // this route forgot. Without it a dev-panel cancel deleted the calendar event and
    // left status='active', so getUpcomingMeetings (which reads the ledger, not
    // Calendar) kept rendering the meeting to the student forever.
    // Guarded like the student route: the event is ALREADY deleted by this point, so
    // an unreadable/missing table must log rather than 500 a cancel that half-happened
    // — scripts/reconcileBookings.cjs closes the row on its next pass.
    try {
      await cancelStandardBookingByEventId(eventId);
    } catch (recordErr) {
      console.error(`developer cancelMeeting: bookings cancel failed for event ${eventId} (event already deleted; reconcile will close the row):`, recordErr?.message || recordErr);
    }

    // Restore the student's booking token. Lookup by studentEmail (admin is logged in,
    // not the student — so we cannot use sessionClaims.email like the student-facing route does).
    if (studentEmail) {
      // Was a Master G:J scan for email -> portal URL -> sheet id. The roster read
      // can throw (getStudentByEmail rethrows a Supabase error so a blip is never
      // read as "no such student"); catching it here keeps the SEV-2 posture the
      // rest of this handler already has — the event is deleted, so log loudly and
      // finish the cancel rather than 500 something that half-happened.
      let cancelSheetId = null;
      try {
        const student = await getStudentByEmail(studentEmail);
        cancelSheetId = student?.student_sheet_id ?? null;
      } catch (rosterErr) {
        console.error(`developer cancelMeeting: roster lookup failed for ${studentEmail} — token NOT restored, re-grant manually:`, rosterErr?.message || rosterErr);
      }

      // Project meetings have their own ledger (freed above) — never restore a standard token.
      if (cancelSheetId && !wasProject) {
        const newValue = instructor.tokenIsTimestamp ? '' : (duration || '15min');
        // Authoritative restore (Supabase booking_tokens; '' = ART clear →
        // delete the row). Best-effort at this point — the event is already
        // deleted; log loudly rather than 500 a cancel that half-happened.
        try {
          await setBookingToken({ studentSheetId: cancelSheetId, slug: instructor.slug, value: newValue });
        } catch (tokenErr) {
          console.error(`developer cancelMeeting: TOKEN RESTORE FAILED for ${studentEmail} (${instructor.slug} → ${JSON.stringify(newValue)}) — re-grant manually:`, tokenErr?.message || tokenErr);
        }
      }

      try {
        await sendStudentCancellationEmail({
          to: studentEmail,
          studentName,
          instructorName: instructor.bodyName || instructor.displayName,
          meetingStart,
        });
      } catch (emailErr) {
        console.error('Failed to send cancellation email:', emailErr);
      }
    }

    return Response.json({ success: true });
  } catch (err) {
    console.error('developer cancelMeeting error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
