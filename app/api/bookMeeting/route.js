import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';
import { getInstructor, validateInstructorHours } from '@/lib/instructors';
import {
  getSeniorByEmail, loadSeniorBookingState, canBookOnDate, recordBooking, consumeOneoff,
  reconsumeOneoff, cancelBookingByEventId, cancelOneoffByEventId,
} from '@/lib/seniors';
import {
  loadProjectPlanForBooking, loadProjectBookingsForPlan, canBookProjectOnDate, recordProjectBooking,
  cancelProjectBookingByEventId,
} from '@/lib/projectMeetings';
import { setBookingToken, getBookingToken, sheetIdFromPortalUrl } from '@/lib/bookingTokens';
import { resolveRescheduleTarget } from '@/lib/rescheduleTarget';

// Human messages for canBookOnDate() rejection reasons (grant gates + package rules).
const SENIOR_DENY = {
  'no-grant': 'Complete this week’s check-in to unlock booking.',
  // Says WHEN the next window opens, not "check in again to unlock it". The old
  // wording read as an instruction to re-check-in immediately, which is what sent a
  // student into the supersede that cost him a cross-meeting on 2026-08-11.
  'out-of-window': 'That date is outside this check-in’s booking window. Your next weekly check-in, from Saturday, opens the week after.',
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

  // A reschedule used to send TWO mails (bookMeeting → bookingEmail, cancelMeeting →
  // cancelEmail) and those differ for Ryan — support@ vs ryan@. It is one request now,
  // so cancelEmail is added here or Ryan's own inbox would stop hearing about moves.
  const recipients = [studentEmail, instructor.bookingEmail];
  if (isReschedule && instructor.cancelEmail) recipients.push(instructor.cancelEmail);

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: [...new Set(recipients.filter(Boolean))].join(', '),
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
    const { start, end, duration, studentName, agenda, isReschedule, instructor: instructorSlug, m, excludeEventId } = body;
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

    // Parsed here, not at the ledger step below, because the hours check needs the
    // LENGTH: a meeting can start inside the window and still end after close.
    const seniorMins = parseInt(String(duration).replace(/\D/g, ''), 10);

    const hoursError = validateInstructorHours(instructor, startTime, seniorMins);
    if (hoursError) {
      return Response.json({ error: hoursError }, { status: 400 });
    }

    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // A reschedule is ONE request: book the replacement, then release the old meeting
    // below. The client cannot be trusted to make the second half of the call — if it
    // simply never cancelled, the exclusion would be a free extra meeting.
    const replacingEventId = await resolveRescheduleTarget(
      calendar, instructor, excludeEventId, email, studentName, now
    );
    if (excludeEventId && !replacingEventId) {
      return Response.json({
        error: 'That meeting can’t be rescheduled — it may have already moved, or it’s within 24 hours.',
      }, { status: 409 });
    }

    // Double-check slot is still free
    const conflictCheck = await calendar.events.list({
      calendarId: instructor.calendarId,
      timeMin: start,
      timeMax: end,
      singleEvents: true,
    });

    // On a reschedule the old meeting is still on the calendar (it is cancelled only
    // after this booking succeeds), so it must not block its own replacement — without
    // this, moving a meeting to an overlapping time reports "just booked by someone else".
    // Every non-cancelled event conflicts, including ones Google marks Free. Deliberate —
    // Ryan blocks time off with all-day events, which Google defaults to "Free" and he
    // doesn't re-mark. Full reasoning in getMonthAvailability; don't change one site alone.
    const conflicts = (conflictCheck.data.items || [])
      .filter(e => e.status !== 'cancelled')
      .filter(e => !replacingEventId || e.id !== replacingEventId);
    if (conflicts.length > 0) {
      return Response.json({
        error: 'This slot was just booked by someone else. Please choose another time.',
      }, { status: 409 });
    }

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
    let seniorOneoffRehydratedFrom = null;
    if (senior) {
      // Reschedule: don't charge the student twice for the meeting they're moving.
      // Mirrors the exclusion getAvailableSlots applied to build this slot list, so the
      // gate here can't contradict what the student was shown. Keyed on the VERIFIED
      // id, never the raw request value.
      const state = await loadSeniorBookingState(senior, replacingEventId);
      const verdict = canBookOnDate(senior, startTime, instructor.slug, seniorMins, state);
      if (!verdict.ok) {
        return Response.json(
          { error: SENIOR_DENY[verdict.reason] || 'You can’t book that meeting.' },
          { status: 409 }
        );
      }
      // `via` tells us which ledger to charge: the weekly grant, or the separate
      // additive one-off track (weekly is always tried first inside canBookOnDate).
      if (verdict.via === 'oneoff') {
        seniorOneoffId = verdict.oneoffId;
        // A one-off surfaced by loadSeniorOneoffs' reschedule rehydration is already
        // 'consumed' by the meeting being moved — re-point it to the new event rather
        // than consume it again (which would match zero rows and leave this booking
        // unpaid for, then hand the one-off back when the old event is cancelled).
        seniorOneoffRehydratedFrom =
          (state.oneoffs || []).find((o) => o.id === verdict.oneoffId)?.rehydratedFrom || null;
      } else seniorGrant = state.grant;
    }

    // Standard (Ryan/Aaron) + ART path — enforce the booking token server-side,
    // the same final-authority contract as the senior/project gates above (the
    // slot endpoints and validateBooking are client-called and can be bypassed
    // by a direct POST; until 2026-08-19 this track never re-checked the token,
    // so the gate blocking 45 of 47 students was enforceable only in the
    // browser — SUMMER-EXIT.md W3). A verified reschedule is exempt from the
    // token check — resolveRescheduleTarget proves the caller owns a future
    // event on this teacher's calendar (ownership, not booking type: a crafted
    // POST could swap a differently-tracked event into a standard one — a swap,
    // not amplification; tightening that means verifying the old event's
    // bookingType here).
    let standardSheetId = null;
    if (!senior && !projectPlanId) {
      const masterRes = await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!A:BD`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
      const masterRows = masterRes.data.values || [];
      const studentRow = masterRows.find((r) => r[9] === email); // col J = email
      standardSheetId = sheetIdFromPortalUrl(studentRow?.[6]);   // col G = portal URL
      if (!standardSheetId) {
        return Response.json({ error: 'No booking authorization found. Please complete your weekly check-in first.' }, { status: 403 });
      }
      if (!replacingEventId) {
        const token = await getBookingToken(standardSheetId, instructor.slug);
        if (instructor.slug === 'art') {
          const isART = studentRow[54] === 'TRUE' || studentRow[54] === true; // col BC
          if (!isART) {
            return Response.json({ error: 'Not part of the Advanced Research Team.' }, { status: 403 });
          }
          if (token) {
            const lastBooked = DateTime.fromISO(String(token)).setZone('America/Los_Angeles');
            let sat = now.set({ weekday: 6 });
            if (now.weekday < 6) sat = sat.minus({ weeks: 1 });
            if (lastBooked.isValid && lastBooked >= sat.startOf('day')) {
              return Response.json({ error: 'You’ve already booked your ART meeting this week.' }, { status: 403 });
            }
          }
        } else {
          if (token !== '15min' && token !== '30min') {
            return Response.json({ error: 'No booking authorization found. Please complete your weekly check-in first.' }, { status: 403 });
          }
          if (parseInt(token, 10) !== seniorMins) {
            return Response.json({ error: 'That meeting length doesn’t match what was granted.' }, { status: 403 });
          }
        }
      }
    }

    // Default the agenda by booking TYPE so the title/description/email/upcoming-card
    // all name WHAT the meeting is; anything the student actually types always wins.
    //   • project meeting → the plan's own label ("ACT Reading", "Competitions", …).
    //     Load-bearing once a student holds SEVERAL weekly sessions, two of them with
    //     the same teacher: without it every card, title and email reads just "Ryan",
    //     and a student naming one of them freehand ("ACT Reading Prep" on the
    //     Competitions slot) is how the track drifts into a catch-all.
    //   • senior, non-project → the college-app essay track ("College Apps"). A senior
    //     is never ART-eligible, so this never collides with the ART prefix below.
    const agendaTrimmed =
      agenda?.trim() || (projectPlan ? projectPlan.label : senior ? 'College Apps' : '');
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
          if (seniorOneoffRehydratedFrom) {
            await reconsumeOneoff(seniorOneoffId, seniorOneoffRehydratedFrom, eventRes.data.id);
          } else {
            await consumeOneoff(seniorOneoffId, eventRes.data.id);
          }
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

    // Release the meeting being replaced. Deliberately runs AFTER the replacement is
    // fully booked and recorded, so the failure direction is "two meetings, cancel one"
    // (recoverable, both visible on the meetings card) rather than "no meeting at all" —
    // which is exactly what cost a student his meeting on 2026-08-11.
    let staleMeetingLeft = false;
    if (replacingEventId) {
      try {
        await calendar.events.delete({ calendarId: instructor.calendarId, eventId: replacingEventId });
      } catch (delErr) {
        const gone = delErr?.code === 404 || delErr?.response?.status === 404;
        if (!gone) {
          console.error('Reschedule: old event could not be deleted:', delErr);
          staleMeetingLeft = true;
        }
      }
      try {
        // Each is a no-op for whichever ledger didn't fund the old meeting. A one-off
        // that DID fund it was re-pointed to the new event above, so cancelOneoff finds
        // nothing and the one-off is correctly not handed back.
        await cancelBookingByEventId(replacingEventId);
        await cancelOneoffByEventId(replacingEventId);
        await cancelProjectBookingByEventId(replacingEventId);
      } catch (ledgerErr) {
        console.error('Reschedule: old ledger rows could not be released:', ledgerErr);
      }
    }

    // Consume the booking token (skip if rescheduling — the original booking
    // consumed it). ART stores the booking instant; everyone else 'no'.
    // Seniors are count-based and project meetings have their OWN ledger (above)
    // — neither holds a token. Authoritative Supabase write; throws on failure →
    // surfaces as a 500 (the event exists either way and the state is visible).
    // Keyed on the VERIFIED replacingEventId, not the client's isReschedule flag:
    // a forged flag with no real meeting to move must not keep the token alive.
    if (!replacingEventId && !senior && !projectPlanId && standardSheetId) {
      const tokenValue = instructor.tokenIsTimestamp ? new Date().toISOString() : 'no';
      await setBookingToken({ studentSheetId: standardSheetId, slug: instructor.slug, value: tokenValue });
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

    // staleMeeting: the replacement is booked but the old event outlived the delete —
    // the student must be told to cancel it, not shown a bare success.
    // agenda: the value we ACTUALLY used, defaults included. The confirmation screen
    // builds the student's own "Add to Google/Apple Calendar" copy from it, so echoing it
    // back is what keeps her saved event ("… 45min: ACT Reading") identical to the
    // teacher's — it was reading only what she typed, so a defaulted agenda was on
    // Ryan's copy and missing from hers.
    return Response.json({ success: true, staleMeeting: staleMeetingLeft, agenda: agendaTrimmed });

  } catch (err) {
    console.error('bookMeeting error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
