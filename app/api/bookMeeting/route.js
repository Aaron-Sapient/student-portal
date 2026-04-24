import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID_RYAN;
const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKIN_TAB = 'CheckinForm';
const ZOOM_LINK = 'https://us02web.zoom.us/j/8846768033';
const RYAN_EMAIL = 'support@admissions.partners';

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

async function sendBookingEmail(studentName, studentEmail, duration, meetingStart, agenda, isReschedule = false) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const dateLabel = new Date(meetingStart).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles',
  });

  const action = isReschedule ? 'rescheduled' : 'booked';
  const agendaLine = agenda ? `\nAgenda: ${agenda}` : '';

await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: `${studentEmail}, ${RYAN_EMAIL}`,
    subject: isReschedule
      ? `Meeting Rescheduled: ${studentName} – ${duration}`
      : `New Meeting Booked: ${studentName} – ${duration}`,
    text: `Hi,\n\n${studentName} has ${action} a ${duration} meeting for ${dateLabel} (Pacific Time).${agendaLine}\n\nZoom: ${ZOOM_LINK}\n\nThis is an automated message from the student portal.`,
  });
}

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
  const { start, end, duration, studentName, agenda, isReschedule } = await request.json();

  if (!start || !end || !duration || !studentName) {
    return Response.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // --- NEW LUXON VALIDATION START ---
  const startTime = DateTime.fromISO(start).setZone('America/Los_Angeles');
  const now = DateTime.now().setZone('America/Los_Angeles');

  // 1. Security Check: 24-hour advance notice
  if (startTime < now.plus({ days: 1 })) {
    return Response.json({ error: 'Meetings require 24-hour advance notice.' }, { status: 400 });
  }

  // 2. Security Check: Valid Day (Tue=2, Wed=3, Thu=4)
  const VALID_DAYS = [2, 3, 4, 5];
if (!VALID_DAYS.includes(startTime.weekday)) {
  return Response.json({ error: 'Meetings can only be booked Tue-Fri.' }, { status: 400 });
}

const hour = startTime.hour;
const isFriday = startTime.weekday === 5;

// Tue-Thu check (4-8pm)
if (!isFriday && (hour < 16 || hour >= 20)) {
  return Response.json({ error: 'Tue-Thu meetings must be 4–8pm.' }, { status: 400 });
}

// Friday check (4-7pm)
if (isFriday && (hour < 16 || hour >= 19)) {
  return Response.json({ error: 'Friday meetings must be 4–7pm.' }, { status: 400 });
}
  // --- NEW LUXON VALIDATION END ---

  const authClient = getServiceAuth();
  const calendar = google.calendar({ version: 'v3', auth: authClient });
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  // ── 1. Double-check slot is still free ───────────────────────────────────
  const conflictCheck = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: start,
    timeMax: end,
    singleEvents: true,
  });
  
  const conflicts = (conflictCheck.data.items || []).filter(e => e.status !== 'cancelled');
  if (conflicts.length > 0) {
    return Response.json({
      error: 'This slot was just booked by someone else. Please choose another time.',
    }, { status: 409 });
  }

    // ── 2. Build event title and description ─────────────────────────────────
    // Title: [Student Name] – 30min: [agenda]  OR  [Student Name] – 30min
    const agendaTrimmed = agenda?.trim() || '';
    const eventTitle = agendaTrimmed
      ? `${studentName} – ${duration}: ${agendaTrimmed}`
      : `${studentName} – ${duration}`;

    const eventDescription = agendaTrimmed
      ? `Zoom: ${ZOOM_LINK}\nAgenda: ${agendaTrimmed}`
      : `Zoom: ${ZOOM_LINK}`;

    // ── 3. Create the calendar event ─────────────────────────────────────────
    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: eventTitle,
        description: eventDescription,
        start: { dateTime: start, timeZone: 'America/Los_Angeles' },
        end: { dateTime: end, timeZone: 'America/Los_Angeles' },
        extendedProperties: {
          private: {
            source: 'student-portal',
            studentEmail: email,
            type: duration,
          },
        },
      },
    });

    // ── 4. Find student row in master sheet ──────────────────────────────────
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!J:J`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const rows = masterRes.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === email) + 1;

    // ── 5. Consume booking token (skip if rescheduling) ──────────────────────
    if (!isReschedule && rowIndex > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!AZ${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['no']] },
      });
    }

    // ── 6. Write agenda to CheckinForm col J (most recent row for this student) ──
    // Find the last CheckinForm row where col B = studentName and update col J
    if (agendaTrimmed) {
      const checkinRes = await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${CHECKIN_TAB}!A:J`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
      const checkinRows = checkinRes.data.values || [];
      // Find last row where col B (index 1) matches studentName
      let lastMatchIndex = -1;
      checkinRows.forEach((r, i) => {
        if (r[1] === studentName) lastMatchIndex = i;
      });
      if (lastMatchIndex > -1) {
        const sheetRow = lastMatchIndex + 1; // 1-indexed
        await sheets.spreadsheets.values.update({
          spreadsheetId: MASTER_SHEET_ID,
          range: `${CHECKIN_TAB}!J${sheetRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[agendaTrimmed]] },
        });
      }
    }

    // ── 7. Email Ryan ────────────────────────────────────────────────────────
    try {
      await sendBookingEmail(studentName, email, duration, start, agendaTrimmed, isReschedule);
    } catch (emailErr) {
      console.error('Failed to send booking email:', emailErr);
    }

    return Response.json({ success: true });

  } catch (err) {
    console.error('bookMeeting error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}