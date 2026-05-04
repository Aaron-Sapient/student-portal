import { google } from 'googleapis';
import { requireDeveloper } from '@/lib/developerAuth';
import { getInstructor } from '@/lib/instructors';
import { sendStudentRescheduleEmail } from '@/lib/studentEmails';

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

    await calendar.events.patch({
      calendarId: instructor.calendarId,
      eventId,
      requestBody: {
        start: { dateTime: newStart, timeZone: 'America/Los_Angeles' },
        end: { dateTime: newEnd, timeZone: 'America/Los_Angeles' },
      },
    });

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
