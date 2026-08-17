import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { requireDeveloper } from '@/lib/developerAuth';
import { getInstructor } from '@/lib/instructors';
import { sendStudentRescheduleEmail } from '@/lib/studentEmails';
import { rescheduleBookingByEventId } from '@/lib/seniors';
import { rescheduleProjectBookingByEventId, projectRescheduleConflict } from '@/lib/projectMeetings';

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
    const { eventId, instructor: instructorSlug, studentEmail, studentName, oldStart, newStart, newEnd } = await request.json();
    if (!eventId || !instructorSlug || !newStart || !newEnd) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const instructor = getInstructor(instructorSlug);
    const calendar = google.calendar({ version: 'v3', auth: getServiceAuth() });

    // Pre-flight the project ledger's 1/week cap BEFORE touching the calendar, so a
    // refused move leaves both untouched (no-op for non-project events).
    const newDt = DateTime.fromISO(newStart, { zone: 'America/Los_Angeles' });
    const conflict = await projectRescheduleConflict(eventId, newDt);
    if (conflict) return Response.json({ error: conflict }, { status: 409 });

    await calendar.events.patch({
      calendarId: instructor.calendarId,
      eventId,
      requestBody: {
        start: { dateTime: newStart, timeZone: 'America/Los_Angeles' },
        end: { dateTime: newEnd, timeZone: 'America/Los_Angeles' },
      },
    });

    // Keep BOTH ledgers' dates in sync (each is a no-op for events that aren't its
    // kind), so same-day/window accounting stays correct after an admin move. The
    // project ledger's week_start is its 1/week cap key: left un-synced, dragging a
    // weekly session across a Saturday reads the old week as consumed and the new week
    // as free — the student can then book a second one (health note 2026-08-06 §1e).
    await rescheduleBookingByEventId(eventId, newDt);
    await rescheduleProjectBookingByEventId(eventId, newDt);

    if (studentEmail) {
      try {
        await sendStudentRescheduleEmail({
          to: studentEmail,
          studentName,
          instructorName: instructor.bodyName || instructor.displayName,
          oldStart,
          newStart,
        });
      } catch (emailErr) {
        console.error('Failed to send reschedule email:', emailErr);
      }
    }

    return Response.json({ success: true });
  } catch (err) {
    console.error('developer rescheduleMeeting error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
