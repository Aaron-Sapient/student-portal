import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DEVELOPER_EMAIL } from '@/lib/developerAuth';

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

// Parses event titles built by bookMeeting:
//   "{ART: }{studentName} – {duration}{: agenda}"
// Returns { studentName, duration } or {} if it doesn't match.
function parseTitle(title) {
  if (!title) return {};
  const stripped = title.replace(/^ART:\s*/, '');
  const m = stripped.match(/^(.+?)\s+[–-]\s+(\d+min|email)/);
  if (!m) return {};
  return { studentName: m[1].trim(), duration: m[2] };
}

export async function GET(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const all = searchParams.get('all') === 'true';
  if (all && email !== DEVELOPER_EMAIL) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    // Admin "all meetings" branch: return events on either calendar whose title
    // contains a known student name. The directory is built from the master sheet
    // (col A name, col J email) so we can resolve a student's full name and email
    // even when an admin types the title freeform like "Aaron-Christine Oh".
    if (all) {
      const now = new Date();
      const eightWeeksOut = new Date(now.getTime() + 8 * 7 * 24 * 60 * 60 * 1000);

      async function fetchAll(calendarId, instructorName) {
        const res = await calendar.events.list({
          calendarId,
          timeMin: now.toISOString(),
          timeMax: eightWeeksOut.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
        });
        return (res.data.items || [])
          .filter(e => e.status !== 'cancelled' && e.summary)
          .map(e => {
            const isArt = e.extendedProperties?.private?.bookingType === 'art'
              || e.summary?.startsWith('ART:');
            const fromExt = e.extendedProperties?.private || {};
            const parsed = parseTitle(e.summary);
            const slug = isArt ? 'art' : (fromExt.instructor || instructorName.toLowerCase());
            return {
              id: e.id,
              title: e.summary,
              start: e.start.dateTime || e.start.date,
              end: e.end.dateTime || e.end.date,
              description: e.description || '',
              instructor: isArt ? 'ART' : instructorName,
              instructorSlug: slug,
              studentEmail: fromExt.studentEmail || null,
              studentName: parsed.studentName || null,
              duration: fromExt.type || parsed.duration || null,
              fromPortal: fromExt.source === 'student-portal',
            };
          });
      }

      // Returns [{ name, normalized, email }, ...] sorted longest-name-first
      // so longer matches win during title scanning (e.g. "Anna Lee" beats "Anna").
      async function fetchStudentDirectory() {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: MASTER_SHEET_ID,
          range: `${MASTER_TAB}!A:J`,
          valueRenderOption: 'UNFORMATTED_VALUE',
        });
        const rows = (res.data.values || []).slice(1); // drop header
        const dir = [];
        for (const r of rows) {
          const name = (r[0] || '').trim();
          const email = (r[9] || '').trim();
          if (!name) continue;
          dir.push({ name, normalized: name.toLowerCase(), email: email || null });
        }
        dir.sort((a, b) => b.normalized.length - a.normalized.length);
        return dir;
      }

      const [ryans, aarons, directory] = await Promise.all([
        fetchAll(RYANS_CALENDAR_ID, 'Ryan'),
        fetchAll(AARONS_CALENDAR_ID, 'Aaron'),
        fetchStudentDirectory(),
      ]);

      const allMeetings = [...ryans, ...aarons]
        .map(m => {
          const titleLower = (m.title || '').toLowerCase();
          // Longest-first scan: first hit is the best (most specific) match.
          const hit = directory.find(s => titleLower.includes(s.normalized));
          if (!hit) return null; // not a student meeting — drop it
          return {
            ...m,
            studentName: hit.name,
            studentEmail: m.studentEmail || hit.email,
          };
        })
        .filter(Boolean)
        .sort((a, b) => new Date(a.start) - new Date(b.start));

      return Response.json({ meetings: allMeetings });
    }

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

      const eventTitle = e.summary.toLowerCase().trim();
      const searchName = studentName.toLowerCase().trim();

      return eventTitle.includes(searchName);
    })
    .map(e => {
      const isArt = e.extendedProperties?.private?.bookingType === 'art'
        || e.summary?.startsWith('ART:');
      return {
        id: e.id,
        title: e.summary,
        start: e.start.dateTime || e.start.date,
        end: e.end.dateTime || e.end.date,
        description: e.description || '',
        instructor: isArt ? 'ART' : instructorName,
      };
    });
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