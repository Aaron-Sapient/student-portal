import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
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
import { setBookingToken, getBookingToken } from '@/lib/bookingTokens';
import {
  studentByEmail, recordStandardBooking, attachCalendarEvent, cancelStandardBookingByEventId,
  pendingBookingsForInstructorDay,
} from '@/lib/bookings';
import { resolveRescheduleTarget } from '@/lib/rescheduleTarget';
import { standingUnavailableWindows, exceedsTeachingRun, overlapsAny } from '@/lib/teachingGuardrails';
import { sendBookingEmail } from '@/lib/bookingEmail';
import { buildEventTitle } from '@/lib/calendarTitles';

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

// Calendar-only. The Sheets scope and every Master/CheckinForm read+write left this
// route on 2026-08-27 (zero-Google sweep, Package C): identity comes from Supabase
// `students`, the booking record is Supabase `bookings`, and the agenda lives on that
// row instead of a CheckinForm cell.
function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

/* sendBookingEmail moved to lib/bookingEmail.js on 2026-09-03, unchanged. The
   per-lead page (/next/<slug>) books real meetings on the same calendar, and
   support@ has to hear about those in the same shape it hears about a student's
   booking. */

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { start, end, duration, agenda, isReschedule, instructor: instructorSlug, m, excludeEventId } = body;
    const instructor = getInstructor(instructorSlug);

    // The student's name is resolved from the SESSION, never from body.studentName.
    // It is not cosmetic: it becomes the calendar event title, and
    // resolveRescheduleTarget uses it as the title fallback when deciding whether an
    // event is yours. Taken from the body, a signed-in student could widen their own
    // reschedule exclusion onto someone else's hand-made meeting. The roster row is
    // also the identity every gate below keys on (sheet id, ART eligibility), so a
    // caller with no roster row fails closed — all callers are student-facing pages.
    const roster = await studentByEmail(email);
    if (!roster) return Response.json({ error: 'Student not found' }, { status: 404 });
    const studentName = String(roster.name || '').trim();

    // Deep-linked project-meeting booking (?m=project:<id> → carried in the POST body).
    const projectPlanId = String(m || '').startsWith('project:') ? String(m).slice('project:'.length) : null;

    if (!start || !end || !duration) {
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

    const dateStr = startTime.toFormat('yyyy-LL-dd');
    const endLA = DateTime.fromISO(end).setZone('America/Los_Angeles');

    // Bookings recorded while Calendar was down carry calendar_event_id null — they
    // exist only in Postgres until reconcile pushes them, so events.list cannot see
    // them at all. Both checks below (the slot conflict window and the teaching-run
    // cap) read Calendar, so without this union a pending booking is invisible to
    // its own slot: the next student books straight over it, and it never counts
    // against the 3.5h run. Read once, used by both.
    // Fails OPEN, loudly: a Postgres blip must not block every booking, and the hole
    // it leaves is exactly the one that existed before this guard.
    let pendingDay = [];
    try {
      const pendingRows = await pendingBookingsForInstructorDay({
        instructor: instructor.slug,
        calendarId: instructor.calendarId,
        dateISO: dateStr,
      });
      pendingDay = pendingRows.map((r) => ({
        start: DateTime.fromISO(r.start_time).setZone('America/Los_Angeles'),
        end: DateTime.fromISO(r.end_time).setZone('America/Los_Angeles'),
      }));
    } catch (pendErr) {
      console.error('bookMeeting: pending-booking read failed (conflict + run checks see Calendar only):', pendErr?.message || pendErr);
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
    // A pending row has no event id, so it can never BE the meeting being replaced
    // (resolveRescheduleTarget resolves against Calendar) — no exclusion applies.
    const pendingConflicts = pendingDay.filter(p => p.start < endLA && p.end > startTime);
    if (conflicts.length > 0 || pendingConflicts.length > 0) {
      return Response.json({
        error: 'This slot was just booked by someone else. Please choose another time.',
      }, { status: 409 });
    }

    // Teaching guardrails — final authority (the slot endpoints can be bypassed).
    // Same three-site rule as the Free/Busy comment above: getAvailableSlots,
    // getMonthAvailability and here must agree. lib/teachingGuardrails.js.
    const candidate = { start: startTime, end: endLA };
    if (overlapsAny(candidate, standingUnavailableWindows(instructor, dateStr))) {
      return Response.json({ error: `${instructor.displayName} isn’t available at that time.` }, { status: 400 });
    }
    if (Number.isFinite(instructor.maxTeachingRunMinutes)) {
      const dayRes = await calendar.events.list({
        calendarId: instructor.calendarId,
        timeMin: startTime.startOf('day').toISO(),
        timeMax: startTime.endOf('day').toISO(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      // Same { start, end } DateTime shape exceedsTeachingRun expects; the pending
      // rows are appended so a calendar-invisible booking still lengthens the run.
      const dayEvents = [
        ...(dayRes.data.items || [])
          .filter(e => e.status !== 'cancelled')
          .filter(e => !replacingEventId || e.id !== replacingEventId)
          // Timed events only — an all-day event would read as a 24h run.
          .filter(e => e.start?.dateTime)
          .map(e => ({
            start: DateTime.fromISO(e.start.dateTime || e.start.date),
            end: DateTime.fromISO(e.end.dateTime || e.end.date),
          })),
        ...pendingDay,
      ];
      if (exceedsTeachingRun(instructor, candidate, dayEvents)) {
        return Response.json({
          error: `That time would put ${instructor.displayName} in too long a stretch of meetings. Please choose a time with a break around it.`,
        }, { status: 409 });
      }
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
    // Identity is the Supabase roster row resolved above (was Master col G/BC).
    const isStandardTrack = !senior && !projectPlanId;
    let standardSheetId = null;
    if (isStandardTrack) {
      standardSheetId = roster.student_sheet_id || null;
      if (!standardSheetId) {
        return Response.json({ error: 'No booking authorization found. Please complete your weekly check-in first.' }, { status: 403 });
      }
      if (!replacingEventId) {
        const token = await getBookingToken(standardSheetId, instructor.slug);
        if (instructor.slug === 'art') {
          // students.art_eligible is a real boolean (the Master col BC 'TRUE' string is gone).
          if (roster.art_eligible !== true) {
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
    const eventTitle = buildEventTitle({
      studentName, duration, agenda: agendaTrimmed, prefix: titlePrefix,
    });

    const eventDescription = agendaTrimmed
      ? `Zoom: ${instructor.zoomLink}\nAgenda: ${agendaTrimmed}`
      : `Zoom: ${instructor.zoomLink}`;

    // Standard/ART: the RECORD is written FIRST (Supabase `bookings`), the event
    // second. Ruling 2026-08-27 (.claude/CLAUDE.md §Data (d)): Calendar is the one
    // accepted dependency, but a Calendar outage must degrade scheduling, never data.
    // An insert failure here 500s cleanly — nothing has been created anywhere yet.
    // (Senior/project keep their event-then-ledger order: their ledgers key on
    // calendar_event_id NOT NULL, so a row without an event would be uncancellable.)
    let bookingRow = null;
    if (isStandardTrack) {
      bookingRow = await recordStandardBooking({
        studentSheetId: standardSheetId,
        studentId: roster.id,
        studentEmail: email,
        instructor: instructor.slug === 'art' ? 'aaron' : instructor.slug,
        track: instructor.slug === 'art' ? 'art' : 'standard',
        calendarId: instructor.calendarId,
        start, end,
        minutes: seniorMins,
        agenda: agendaTrimmed || null,
      });
    }

    let eventRes = null;
    let calendarSyncPending = false;
    try {
      eventRes = await calendar.events.insert({
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
              // The record's own id, so a hand-edited or orphaned event can always be
              // traced back to its row (scripts/reconcileBookings.cjs).
              ...(bookingRow ? { bookingId: bookingRow.id } : {}),
            },
          },
        },
      });
    } catch (calErr) {
      if (!bookingRow) throw calErr; // senior/project: nothing recorded yet → 500 as before
      // The booking EXISTS (the row is the truth). The event is pending; the
      // reconcile script enumerates rows with calendar_event_id null and pushes them.
      console.error(`bookMeeting: Calendar insert failed — booking ${bookingRow.id} recorded with calendar sync pending:`, calErr?.message || calErr);
      calendarSyncPending = true;
    }

    const eventId = eventRes?.data?.id || null;
    if (bookingRow && eventId) {
      try {
        await attachCalendarEvent(bookingRow.id, eventId);
      } catch (attachErr) {
        // Loud, not fatal: the event and the row both exist; the reconcile script's
        // bookingId extendedProperty match re-attaches it.
        console.error(`bookMeeting: could not attach event ${eventId} to booking ${bookingRow.id}:`, attachErr?.message || attachErr);
      }
    }

    // Project booking: record on its own ledger. If the write fails, delete the
    // just-created event so we never leave an un-accounted booking (same rollback
    // contract as the senior path below).
    if (projectPlan) {
      try {
        await recordProjectBooking(projectPlan, {
          eventId,
          dt: startTime,
          minutes: seniorMins,
          studentSheetId: projectPlan.student_sheet_id,
        });
      } catch (ledgerErr) {
        console.error('Project booking ledger write failed — rolling back event:', ledgerErr);
        try {
          await calendar.events.delete({ calendarId: instructor.calendarId, eventId });
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
            await reconsumeOneoff(seniorOneoffId, seniorOneoffRehydratedFrom, eventId);
          } else {
            await consumeOneoff(seniorOneoffId, eventId);
          }
        } else {
          await recordBooking(seniorGrant, {
            eventId,
            teacher: instructor.slug,
            dt: startTime,
            minutes: seniorMins,
            studentSheetId: senior.student_sheet_id,
          });
        }
      } catch (ledgerErr) {
        console.error('Senior booking ledger write failed — rolling back event:', ledgerErr);
        try {
          await calendar.events.delete({ calendarId: instructor.calendarId, eventId });
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
    let oldMeetingKept = false;
    if (replacingEventId && calendarSyncPending) {
      // The replacement event does NOT exist — the Calendar insert failed and only the
      // ROW was written. Deleting the old event here would take the student's meeting
      // off the calendar and put nothing in its place, which is the same "no meeting at
      // all" outcome the book-first ordering above exists to prevent. So the old
      // meeting is left whole, event AND ledger rows: reconcile pushes the pending row,
      // and the old one is cancelled deliberately afterwards.
      oldMeetingKept = true;
      staleMeetingLeft = true;
      console.error(`bookMeeting: reschedule while Calendar was unavailable — old event ${replacingEventId} kept (new booking ${bookingRow?.id || '(none)'} is calendar-sync pending).`);
    } else if (replacingEventId) {
      try {
        await calendar.events.delete({ calendarId: instructor.calendarId, eventId: replacingEventId });
      } catch (delErr) {
        const gone = delErr?.code === 404 || delErr?.response?.status === 404
          || delErr?.code === 410 || delErr?.response?.status === 410;
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
        await cancelStandardBookingByEventId(replacingEventId);
      } catch (ledgerErr) {
        console.error('Reschedule: old ledger rows could not be released:', ledgerErr);
      }
    }

    // Consume the booking token (skip if rescheduling — the original booking
    // consumed it). ART stores the booking instant; everyone else 'no'.
    // Seniors are count-based and project meetings have their OWN ledger (above)
    // — neither holds a token. Authoritative Supabase write; throws on failure →
    // surfaces as a 500 (the booking row exists either way and the state is visible).
    // Keyed on the VERIFIED replacingEventId, not the client's isReschedule flag:
    // a forged flag with no real meeting to move must not keep the token alive.
    if (!replacingEventId && isStandardTrack && standardSheetId) {
      const tokenValue = instructor.tokenIsTimestamp ? new Date().toISOString() : 'no';
      await setBookingToken({ studentSheetId: standardSheetId, slug: instructor.slug, value: tokenValue });
    }

    // The agenda used to be written back to the CheckinForm tab (col J / H) by an exact
    // name match. It now lives on the bookings row (`agenda`), written above.

    try {
      await sendBookingEmail(instructor, studentName, email, duration, start, agendaTrimmed, isReschedule);
    } catch (emailErr) {
      console.error('Failed to send booking email:', emailErr);
    }

    // staleMeeting: the replacement is booked but the old event outlived the delete —
    // the student must be told to cancel it, not shown a bare success.
    // calendarSyncPending: the booking is recorded but the calendar event could not be
    // created (Calendar outage) — the meeting IS booked; the event follows via reconcile.
    // agenda: the value we ACTUALLY used, defaults included. The confirmation screen
    // builds the student's own "Add to Google/Apple Calendar" copy from it, so echoing it
    // back is what keeps her saved event ("… 45min: ACT Reading") identical to the
    // teacher's — it was reading only what she typed, so a defaulted agenda was on
    // Ryan's copy and missing from hers.
    // oldMeetingKept: a reschedule whose replacement event could not be created — the
    // old meeting was deliberately NOT released, so the student still has the original
    // on the calendar. Reported separately from staleMeeting (which means the delete
    // was attempted and failed) so a caller can tell "we chose not to" from "we tried".
    return Response.json({
      success: true,
      staleMeeting: staleMeetingLeft,
      oldMeetingKept,
      calendarSyncPending,
      bookingId: bookingRow?.id || null,
      agenda: agendaTrimmed,
    });

  } catch (err) {
    console.error('bookMeeting error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
