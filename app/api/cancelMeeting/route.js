import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';
import { getInstructor } from '@/lib/instructors';

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

async function sendCancellationEmail(instructor, studentName, meetingTitle, meetingStart) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const dateLabel = new Date(meetingStart).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles',
  });

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: instructor.cancelEmail,
    subject: `Meeting Cancelled: ${meetingTitle}`,
    text: `Hi ${instructor.displayName},\n\n${studentName} has cancelled their meeting scheduled for ${dateLabel} (Pacific Time).\n\nThey have been informed they can rebook at their convenience through the student portal.\n\nThis is an automated message from the student portal.`,
  });
}

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { eventId, studentName, meetingTitle, meetingStart, duration, instructor: instructorSlug, isReschedule } = await request.json();
    if (!eventId) return Response.json({ error: 'Missing eventId' }, { status: 400 });

    const instructor = getInstructor(instructorSlug);

    const startTime = DateTime.fromISO(meetingStart).setZone('America/Los_Angeles');
    const now = DateTime.now().setZone('America/Los_Angeles');
    if (startTime < now.plus({ days: 1 })) {
      return Response.json({
        error: 'Meetings must be cancelled at least 24 hours in advance.',
      }, { status: 400 });
    }

    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    await calendar.events.delete({
      calendarId: instructor.calendarId,
      eventId,
    });

    // Reset the instructor's booking column to 'no'
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!J:J`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = masterRes.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === email) + 1;

    // Token logic:
    //  - Reschedule (cancel half of a reschedule flow): leave token consumed; bookMeeting will not re-consume.
    //  - Real cancel + standard tracking: restore token to the meeting's original duration ('15min' / '30min').
    //  - Real cancel + timestamp tracking (ART): clear the column so weekly check sees no booking.
    if (rowIndex > 0) {
      let newValue = null;
      if (instructor.tokenIsTimestamp) {
        if (!isReschedule) newValue = '';
      } else {
        newValue = isReschedule ? 'no' : (duration || '15min');
      }
      if (newValue !== null) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: MASTER_SHEET_ID,
          range: `${MASTER_TAB}!${instructor.masterColumn}${rowIndex}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[newValue]] },
        });
      }
    }

    try {
      await sendCancellationEmail(instructor, studentName, meetingTitle, meetingStart);
    } catch (emailErr) {
      console.error('Failed to send cancellation email:', emailErr);
    }

    return Response.json({ success: true });

  } catch (err) {
    console.error('cancelMeeting error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
