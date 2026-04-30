import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';
import { getInstructor, validateInstructorHours } from '@/lib/instructors';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const RYAN_CHECKIN_TAB = 'CheckinForm';
const AARON_CHECKIN_TAB = 'A_CheckinForm';

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

async function sendBookingEmail(instructor, studentName, studentEmail, duration, meetingStart, agenda, isReschedule = false) {
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
  // Ryan's 15-minute meetings are phone calls — never share Zoom details with the student.
  const isPhoneCall = instructor.slug === 'ryan' && duration === '15min';
  const zoomLine = isPhoneCall ? '' : `\n\nZoom: ${instructor.zoomLink}`;

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: `${studentEmail}, ${instructor.bookingEmail}`,
    subject: isReschedule
      ? `Meeting Rescheduled: ${studentName} – ${duration} with ${instructor.displayName}`
      : `New Meeting Booked: ${studentName} – ${duration} with ${instructor.displayName}`,
    text: `Hi,\n\n${studentName} has ${action} a ${duration} meeting with ${instructor.displayName} for ${dateLabel} (Pacific Time).${agendaLine}${zoomLine}\n\nThis is an automated message from the student portal.`,
  });
}

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { start, end, duration, studentName, agenda, isReschedule, instructor: instructorSlug } = body;
    const instructor = getInstructor(instructorSlug);

    if (!start || !end || !duration || !studentName) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const startTime = DateTime.fromISO(start).setZone('America/Los_Angeles');
    const now = DateTime.now().setZone('America/Los_Angeles');

    if (startTime < now.plus({ days: 1 })) {
      return Response.json({ error: 'Meetings require 24-hour advance notice.' }, { status: 400 });
    }

    const hoursError = validateInstructorHours(instructor, startTime);
    if (hoursError) {
      return Response.json({ error: hoursError }, { status: 400 });
    }

    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Double-check slot is still free
    const conflictCheck = await calendar.events.list({
      calendarId: instructor.calendarId,
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

    const agendaTrimmed = agenda?.trim() || '';
    const titlePrefix = instructor.slug === 'art' ? 'ART: ' : '';
    const eventTitle = agendaTrimmed
      ? `${titlePrefix}${studentName} – ${duration}: ${agendaTrimmed}`
      : `${titlePrefix}${studentName} – ${duration}`;

    // Ryan's 15-minute meetings are phone calls — no Zoom details in the event description.
    const isPhoneCall = instructor.slug === 'ryan' && duration === '15min';
    const eventDescription = isPhoneCall
      ? (agendaTrimmed ? `Agenda: ${agendaTrimmed}` : '')
      : (agendaTrimmed
        ? `Zoom: ${instructor.zoomLink}\nAgenda: ${agendaTrimmed}`
        : `Zoom: ${instructor.zoomLink}`);

    await calendar.events.insert({
      calendarId: instructor.calendarId,
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
            instructor: instructor.slug,
            bookingType: instructor.slug === 'art' ? 'art' : 'standard',
          },
        },
      },
    });

    // Find student row in master sheet
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!J:J`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const rows = masterRes.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === email) + 1;

    // Consume booking token (skip if rescheduling — token already consumed by the original booking).
    // ART tracks the timestamp of the booking; everyone else uses a 'no' flag.
    if (!isReschedule && rowIndex > 0) {
      const tokenValue = instructor.tokenIsTimestamp ? new Date().toISOString() : 'no';
      await sheets.spreadsheets.values.update({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!${instructor.masterColumn}${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[tokenValue]] },
      });
    }

    // Write agenda back to the appropriate CheckinForm tab.
    // Ryan's tab: col J. Aaron's tab: col H.
    if (agendaTrimmed) {
      const checkinTab = instructor.slug === 'aaron' ? AARON_CHECKIN_TAB : RYAN_CHECKIN_TAB;
      const agendaCol = instructor.slug === 'aaron' ? 'H' : 'J';
      const checkinRes = await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${checkinTab}!A:J`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
      const checkinRows = checkinRes.data.values || [];
      let lastMatchIndex = -1;
      checkinRows.forEach((r, i) => {
        if (r[1] === studentName) lastMatchIndex = i;
      });
      if (lastMatchIndex > -1) {
        const sheetRow = lastMatchIndex + 1;
        await sheets.spreadsheets.values.update({
          spreadsheetId: MASTER_SHEET_ID,
          range: `${checkinTab}!${agendaCol}${sheetRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[agendaTrimmed]] },
        });
      }
    }

    try {
      await sendBookingEmail(instructor, studentName, email, duration, start, agendaTrimmed, isReschedule);
    } catch (emailErr) {
      console.error('Failed to send booking email:', emailErr);
    }

    return Response.json({ success: true });

  } catch (err) {
    console.error('bookMeeting error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
