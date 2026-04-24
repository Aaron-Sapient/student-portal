import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';

const RYANS_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID_RYAN;
const AARONS_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID_AARON;
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

    // 1. Get student name from master sheet
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:AY`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = masterRes.data.values || [];
    const studentRow = rows.find(r => r[9] === email);

    if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 });

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

    // 2. Define constants for the calendar fetch
    const now = new Date();
    const eightWeeksOut = new Date(now.getTime() + 8 * 7 * 24 * 60 * 60 * 1000);

    // HELPER FUNCTION: Defined inside GET to use 'calendar', 'now', etc.
    async function fetchFromCalendar(calendarId, instructorName) {
      const res = await calendar.events.list({
        calendarId: calendarId,
        timeMin: now.toISOString(),
        timeMax: eightWeeksOut.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });
      
return (res.data.items || [])
    .filter(e => {
      if (e.status === 'cancelled' || !e.summary) return false;
      
      // Clean up the names to prevent tiny typos from breaking the match
      const eventTitle = e.summary.toLowerCase().trim();
      const searchName = studentName.toLowerCase().trim();
      
      return eventTitle.includes(searchName);
    })
    .map(e => ({
      id: e.id,
      title: e.summary,
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      description: e.description || '',
      instructor: instructorName
    }));
}

    // 3. Fetch from both calendars at the same time
    const [ryansEvents, aaronsEvents] = await Promise.all([
      fetchFromCalendar(RYANS_CALENDAR_ID, 'Ryan'),
      fetchFromCalendar(AARONS_CALENDAR_ID, 'Aaron')
    ]);

    // 4. Combine and Sort by Date
    const allMeetings = [...ryansEvents, ...aaronsEvents].sort((a, b) => 
      new Date(a.start) - new Date(b.start)
    );

    return Response.json({ meetings: allMeetings, studentName });

  } catch (err) {
    console.error('getUpcomingMeetings error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}