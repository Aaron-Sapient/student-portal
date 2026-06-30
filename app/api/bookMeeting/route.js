import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';
import { getInstructor, validateInstructorHours } from '@/lib/instructors';
import { getSeniorByEmail, loadSeniorBookingState, canBookOnDate, recordBooking, consumeOneoff } from '@/lib/seniors';
import { loadProjectPlanForBooking, loadProjectBookingsForPlan, canBookProjectOnDate, recordProjectBooking } from '@/lib/projectMeetings';

// Human messages for canBookOnDate() rejection reasons (grant gates + package rules).
const SENIOR_DENY = {
  'no-grant': 'Complete this week’s check-in to unlock booking.',
  'out-of-window': 'You can only book inside this check-in’s window. Next week’s check-in unlocks the week after.',
  'same-day': 'You already have a meeting that day — pick another day.',
  'tokens-used': 'You’ve booked all the meetings this check-in unlocked.',
  'wrong-teacher': 'That teacher isn’t bookable for you right now.',
  'cross-reserved': 'A slot is reserved for your monthly cross-meeting with your other teacher — book that one.',
  'secondary-done': 'You’ve already booked your once-a-month cross-meeting.',
  'budget-used': 'You’ve used all your meeting time for this check-in.',
  'bad-duration': 'That meeting length isn’t available on your package.',
};

// Human messages for canBookProjectOnDate() rejections (standing project-meeting track).
const PROJECT_DENY = {
  'no-plan': 'That project meeting isn’t set up for you.',
  'wrong-teacher': 'That isn’t your project-meeting teacher.',
  'bad-duration': 'That meeting length isn’t set for your project meeting.',
  'out-of-window': 'You can book your project meeting for this week or next.',
  'week-booked': 'You’ve already booked this week’s project meeting.',
};

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

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: `${studentEmail}, ${instructor.bookingEmail}`,
    subject: isReschedule
      ? `Meeting Rescheduled: ${studentName} – ${duration} with ${instructor.displayName}`
      : `New Meeting Booked: ${studentName} – ${duration} with ${instructor.displayName}`,
    text: `Hi,\n\n${studentName} has ${action} a ${duration} meeting with ${instructor.displayName} for ${dateLabel} (Pacific Time).${agendaLine}\n\nZoom: ${instructor.zoomLink}\n\nThis is an automated message from the student portal.`,
  });
}

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { start, end, duration, studentName, agenda, isReschedule, instructor: instructorSlug, m } = body;
    const instructor = getInstructor(instructorSlug);
    // Deep-linked project-meeting booking (?m=project:<id> → carried in the POST body).
    const projectPlanId = String(m || '').startsWith('project:') ? String(m).slice('project:'.length) : null;

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

    const seniorMins = parseInt(String(duration).replace(/\D/g, ''), 10);

    // The booked event's ACTUAL span must equal the validated/charged length. Both
    // canBookOnDate/canBookProjectOnDate and the ledger key off `seniorMins` (from the
    // `duration` string), while the calendar event is created from the client's
    // start/end — so without this a crafted request could charge 15 of the 30-min
    // budget while placing a longer event. Legit flows always match (slots are
    // generated at exactly this length), so this never rejects a real booking.
    const endTime = DateTime.fromISO(end).setZone('America/Los_Angeles');
    const spanMins = endTime.isValid ? Math.round(endTime.diff(startTime, 'minutes').minutes) : NaN;
    if (!Number.isFinite(seniorMins) || spanMins !== seniorMins) {
      return Response.json({ error: 'Meeting length mismatch.' }, { status: 400 });
    }

    // Project-meeting path — the final authority (slot endpoints can be bypassed).
    // Authorize against the standing plan + 1/week ledger, NOT the essay/senior gate,
    // so a senior's project booking with their essay teacher can't be charged to the
    // essay grant. Recorded on its OWN ledger AFTER the event is created (below).
    let projectPlan = null;
    if (projectPlanId) {
      projectPlan = await loadProjectPlanForBooking(email, projectPlanId);
      if (!projectPlan || projectPlan.teacher !== instructor.slug) {
        return Response.json({ error: 'That project meeting isn’t available to book.' }, { status: 409 });
      }
      const bookings = await loadProjectBookingsForPlan(projectPlanId, now);
      const verdict = canBookProjectOnDate(projectPlan, startTime, instructor.slug, seniorMins, bookings, now);
      if (!verdict.ok) {
        return Response.json(
          { error: PROJECT_DENY[verdict.reason] || 'You can’t book that project meeting.' },
          { status: 409 }
        );
      }
    }

    // Senior essay path — the final authority (slot endpoints can be bypassed).
    // Authorize against the auditable token ledger: an active check-in grant, the
    // meeting in the grant's window, no same-day collision, tokens left, and the
    // per-week teacher/length/secondary-first rules. On success the booking is recorded
    // against the grant AFTER the calendar event is created (below). Skipped for a
    // project booking (its own gate ran above).
    const senior = projectPlanId ? null : await getSeniorByEmail(email);
    let seniorGrant = null;
    let seniorOneoffId = null;
    if (senior) {
      const state = await loadSeniorBookingState(senior);
      const verdict = canBookOnDate(senior, startTime, instructor.slug, seniorMins, state);
      if (!verdict.ok) {
        return Response.json(
          { error: SENIOR_DENY[verdict.reason] || 'You can’t book that meeting.' },
          { status: 409 }
        );
      }
      // `via` tells us which ledger to charge: the weekly grant, or the separate
      // additive one-off track (weekly is always tried first inside canBookOnDate).
      if (verdict.via === 'oneoff') seniorOneoffId = verdict.oneoffId;
      else seniorGrant = state.grant;
    }

    const agendaTrimmed = agenda?.trim() || '';
    const titlePrefix = instructor.slug === 'art' ? 'ART: ' : '';
    const eventTitle = agendaTrimmed
      ? `${titlePrefix}${studentName} – ${duration}: ${agendaTrimmed}`
      : `${titlePrefix}${studentName} – ${duration}`;

    const eventDescription = agendaTrimmed
      ? `Zoom: ${instructor.zoomLink}\nAgenda: ${agendaTrimmed}`
      : `Zoom: ${instructor.zoomLink}`;

    const eventRes = await calendar.events.insert({
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
            bookingType: projectPlanId ? 'project' : senior ? 'senior' : instructor.slug === 'art' ? 'art' : 'standard',
            // Plan id on the event so getUpcomingMeetings can identify a project meeting
            // (the reschedule UI routes those to cancel+rebook, never a bare-rebook that
            // would drop the project track and mis-charge the essay grant).
            ...(projectPlanId ? { projectPlanId } : {}),
          },
        },
      },
    });

    // Project booking: record on its own ledger. If the write fails, delete the
    // just-created event so we never leave an un-accounted booking (same rollback
    // contract as the senior path below).
    if (projectPlan) {
      try {
        await recordProjectBooking(projectPlan, {
          eventId: eventRes.data.id,
          dt: startTime,
          minutes: seniorMins,
          studentSheetId: projectPlan.student_sheet_id,
        });
      } catch (ledgerErr) {
        console.error('Project booking ledger write failed — rolling back event:', ledgerErr);
        try {
          await calendar.events.delete({ calendarId: instructor.calendarId, eventId: eventRes.data.id });
        } catch (delErr) {
          console.error('Failed to roll back orphaned event:', delErr);
        }
        // 23505 = the pmb_one_active_per_week unique violation: a concurrent request won
        // the week. Surface it as the honest "already booked this week" rather than a 500.
        const weekRace = ledgerErr?.code === '23505';
        return Response.json(
          { error: weekRace ? PROJECT_DENY['week-booked'] : 'Booking could not be recorded. Please try again.' },
          { status: weekRace ? 409 : 500 }
        );
      }
    }

    // Seniors: record the consumption against whichever ledger authorized it (the
    // weekly grant, or the separate one-off track). If the ledger write fails, delete
    // the just-created event so we never leave an un-accounted booking.
    if (senior && (seniorGrant || seniorOneoffId)) {
      try {
        if (seniorOneoffId) {
          await consumeOneoff(seniorOneoffId, eventRes.data.id);
        } else {
          await recordBooking(seniorGrant, {
            eventId: eventRes.data.id,
            teacher: instructor.slug,
            dt: startTime,
            minutes: seniorMins,
            studentSheetId: senior.student_sheet_id,
          });
        }
      } catch (ledgerErr) {
        console.error('Senior booking ledger write failed — rolling back event:', ledgerErr);
        try {
          await calendar.events.delete({ calendarId: instructor.calendarId, eventId: eventRes.data.id });
        } catch (delErr) {
          console.error('Failed to roll back orphaned event:', delErr);
        }
        return Response.json({ error: 'Booking could not be recorded. Please try again.' }, { status: 500 });
      }
    }

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
    // Seniors have NO token (deterministic, count-based) — never write a column for them.
    // Project meetings have their OWN ledger (above) — never touch a Master token column.
    if (!isReschedule && rowIndex > 0 && !senior && !projectPlanId) {
      const tokenValue = instructor.tokenIsTimestamp ? new Date().toISOString() : 'no';
      await sheets.spreadsheets.values.update({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!${instructor.masterColumn}${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[tokenValue]] },
      });
    }

    // Write agenda back to the appropriate CheckinForm tab.
    // Ryan's tab: col J. Aaron's tab: col H. Skip for project meetings — there's no
    // check-in row to attach to, and a name-match write could clobber an unrelated row.
    if (agendaTrimmed && !projectPlanId) {
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
