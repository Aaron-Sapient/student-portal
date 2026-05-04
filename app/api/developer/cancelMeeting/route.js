import { google } from 'googleapis';
import { requireDeveloper } from '@/lib/developerAuth';
import { getInstructor } from '@/lib/instructors';
import { sendStudentCancellationEmail } from '@/lib/studentEmails';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
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
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    await calendar.events.delete({ calendarId: instructor.calendarId, eventId });

    // Restore the student's booking token. Lookup by studentEmail (admin is logged in,
    // not the student — so we cannot use sessionClaims.email like the student-facing route does).
    if (studentEmail) {
      const masterRes = await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!J:J`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
      const rows = masterRes.data.values || [];
      const rowIndex = rows.findIndex(r => r[0] === studentEmail) + 1;

      if (rowIndex > 0) {
        const newValue = instructor.tokenIsTimestamp ? '' : (duration || '15min');
        await sheets.spreadsheets.values.update({
          spreadsheetId: MASTER_SHEET_ID,
          range: `${MASTER_TAB}!${instructor.masterColumn}${rowIndex}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[newValue]] },
        });
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
