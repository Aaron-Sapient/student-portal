import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID_RYAN;
const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
  });
}

export async function GET() {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    // Get student name from master sheet
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:AY`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = masterRes.data.values || [];
    const studentRow = rows.find(r => r[9 - 0] === email) || rows.find((r, i) => {
      // col J = index 9
      return r[9] === email;
    });

    if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 });

    // Get student name from their portal sheet
    const studentSheetUrl = studentRow[6];
    const sheetIdMatch = studentSheetUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) return Response.json({ meetings: [] });
    const studentSheetId = sheetIdMatch[1];

    const nameRes = await sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: '🔎 Overview!B2',
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const studentName = nameRes.data.values?.[0]?.[0] || '';
    if (!studentName) return Response.json({ meetings: [] });

    // Fetch upcoming events from Ryan's calendar
    const now = new Date();
    const eightWeeksOut = new Date(now.getTime() + 8 * 7 * 24 * 60 * 60 * 1000);

    const eventsRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: now.toISOString(),
      timeMax: eightWeeksOut.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      q: studentName, // search by student name in event title
    });

    const events = eventsRes.data.items || [];

    // Filter to events that actually have this student's name in the title
    const studentEvents = events
      .filter(e =>
        e.status !== 'cancelled' &&
        e.summary?.includes(studentName)
      )
      .map(e => ({
        id: e.id,
        title: e.summary,
        start: e.start.dateTime,
        end: e.end.dateTime,
        description: e.description || '',
      }));

    return Response.json({ meetings: studentEvents, studentName });

  } catch (err) {
    console.error('getUpcomingMeetings error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}