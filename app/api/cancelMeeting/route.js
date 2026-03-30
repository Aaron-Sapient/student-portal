import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID_RYAN;
const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const RYAN_EMAIL = 'ryan@admissions.partners';

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

async function sendCancellationEmail(studentName, meetingTitle, meetingStart) {
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
    to: RYAN_EMAIL,
    subject: `Meeting Cancelled: ${meetingTitle}`,
    text: `Hi Ryan,\n\n${studentName} has cancelled their meeting scheduled for ${dateLabel} (Pacific Time).\n\nThey have been informed they can rebook at their convenience through the student portal.\n\nThis is an automated message from the student portal.`,
  });
}

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { eventId, studentName, meetingTitle, meetingStart } = await request.json();
    if (!eventId) return Response.json({ error: 'Missing eventId' }, { status: 400 });

    // Enforce 24-hour cancellation window server-side
    const startTime = new Date(meetingStart);
    if (startTime < new Date(Date.now() + 24 * 60 * 60 * 1000)) {
      return Response.json({
        error: 'Meetings must be cancelled at least 24 hours in advance.',
      }, { status: 400 });
    }

    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // 1. Delete the calendar event
    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId,
    });

    // 2. Reset col AZ to 'no' in master sheet
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!J:J`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = masterRes.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === email) + 1;

    if (rowIndex > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!AZ${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['no']] },
      });
    }

    // 3. Email Ryan
    try {
      await sendCancellationEmail(studentName, meetingTitle, meetingStart);
    } catch (emailErr) {
      // Don't fail the whole request if email fails
      console.error('Failed to send cancellation email:', emailErr);
    }

    return Response.json({ success: true });

  } catch (err) {
    console.error('cancelMeeting error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}