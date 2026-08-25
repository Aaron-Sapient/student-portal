import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { resolveCheckinStudent } from '@/lib/checkinIdentity';
import { getInstructor, validateInstructorHours } from '@/lib/instructors';
import { fetchOwnedEvent } from '@/lib/rescheduleTarget';
import { listBlocksForBooking, isDateBlocked, blockedWindowsForDate } from '@/lib/blocks';
import {
  loadProjectPlanForBooking,
  projectRescheduleConflict,
  rescheduleProjectBookingByEventId,
  loadActiveProjectBookingByEventId,
} from '@/lib/projectMeetings';
import {
  projectHorizon,
  projectSourceUnlocked,
  projectRescheduleFloor,
  SAME_DAY_EARLIEST_HOUR,
  ZONE,
} from '@/lib/projectMeetingsCore';
import { sendStudentRescheduleEmail } from '@/lib/studentEmails';

// STUDENT-FACING in-place reschedule for a standing project meeting.
//
// WHY THIS IS A SEPARATE ROUTE, and not `?m=project:` + excludeEventId on bookMeeting.
// bookMeeting INSERTS the new ledger row before cancelling the old one (deliberate —
// that ordering is what stops a failed rebook from leaving a student with no meeting at
// all, the 2026-08-11 incident). But project_meeting_bookings carries a DB-level partial
// unique index:
//     create unique index pmb_one_active_per_week
//       on project_meeting_bookings (plan_id, week_start) where status = 'active';
// so an insert-then-cancel move WITHIN one Saturday-week — which is the common case, a
// student shuffling this week's session by a day or two — raises 23505, rolls the just-
// created event back, and hands the student "You've already booked this week's project
// meeting." Filtering the moved row out of the in-memory cap check cannot help: the
// constraint is in Postgres, not in the check.
//
// So this route uses the shape the ADMIN reschedule has used since it shipped
// (app/api/developer/rescheduleMeeting): pre-flight the cap with projectRescheduleConflict
// (which excludes the row being moved by id), then events.patch the SAME calendar event
// and UPDATE the SAME ledger row. One row throughout, so the unique index is never even
// approached, and there is no window in which two active rows or two calendar events
// exist. It also means no ledger row is ever released, which is what makes the
// cross-track hole impossible here: this route can only ever move a project meeting onto
// its own plan — it has no code path that deletes an essay meeting or refunds a token.
//
// TIMING (2026-08-24 · Aaron). Project meetings are exempt from the 24-hour reschedule
// notice that governs every other track, because the case this exists to serve is a
// student who wakes up sick on the day. In its place:
//   • SOURCE LOCK  — the meeting being moved must be more than 2 hours away. Inside that,
//     it is frozen exactly as today (the client hides both buttons; this re-checks it).
//   • DESTINATION  — the new slot must be at least 2 hours out, and if it lands on TODAY
//     it must start at or after 16:00 LA. Aaron does not want his early-afternoon slots
//     churned same-day; a same-day move goes to the evening or to another day.
// Both are enforced HERE, not only in the slot endpoints, because those are display and
// are documented as bypassable. The numbers themselves live in projectMeetingsCore so the
// offer side and the accept side cannot drift apart.

// Best-effort display name for the confirmation email. Never throws: a reschedule that
// already succeeded must not be reported as a failure because a sheet lookup hiccuped.
async function studentNameFor() {
  try {
    const t = await resolveCheckinStudent();
    return t?.error ? null : t?.studentName || null;
  } catch {
    return null;
  }
}

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { eventId, instructor: instructorSlug, start, end } = body;
    if (!eventId || !start || !end) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }
    const instructor = getInstructor(instructorSlug);

    const now = DateTime.now().setZone(ZONE);
    const startTime = DateTime.fromISO(start).setZone(ZONE);
    const endTime = DateTime.fromISO(end).setZone(ZONE);
    if (!startTime.isValid || !endTime.isValid) {
      return Response.json({ error: 'Invalid meeting time.' }, { status: 400 });
    }

    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    // Ownership, against the live event. Returns null for unknown / cancelled / not-yours.
    // studentName is deliberately NOT passed: it only enables fetchOwnedEvent's title
    // fallback for hand-made events, and such an event carries no extendedProperties, so
    // it is rejected three lines below anyway. Omitting it is the safe direction AND
    // skips a full Master-sheet read (which would also 404 a student missing from col J).
    const ev = await fetchOwnedEvent(calendar, instructor, eventId, email, null);
    if (!ev) {
      return Response.json({ error: 'That meeting can’t be found on your calendar.' }, { status: 409 });
    }

    // This route moves project meetings ONLY. Every other track keeps the 24-hour rule and
    // goes through bookMeeting, so refusing here is what stops the relaxed timing below
    // from becoming a way to move an essay or standard meeting on 2 hours' notice.
    const ext = ev.extendedProperties?.private || {};
    const planId = ext.projectPlanId || null;
    if (ext.bookingType !== 'project' || !planId) {
      return Response.json({
        error: 'That meeting isn’t a project meeting — reschedule it from your meetings list.',
      }, { status: 409 });
    }

    // SOURCE LOCK: inside 2 hours the meeting is frozen. Reads `dateTime` ONLY — an
    // all-day event has a zoneless `date`, which fromISO would parse in the SERVER's zone
    // (UTC on Vercel) and land on 17:00 the previous LA day. A project meeting is always
    // timed, so an all-day one is malformed and refusing is correct.
    const currentStart = DateTime.fromISO(ev.start?.dateTime || '').setZone(ZONE);
    if (!projectSourceUnlocked(currentStart, now)) {
      return Response.json({
        error: 'Changes are locked within 2 hours of the meeting.',
      }, { status: 409 });
    }

    // The plan, re-verified against the signed-in student (not just against the event).
    // loadProjectPlanForBooking refuses a plan that isn't theirs or is no longer active.
    const plan = await loadProjectPlanForBooking(email, planId);
    if (!plan) {
      return Response.json({
        error: 'That weekly session is no longer set up — cancel this meeting and book a new time.',
      }, { status: 409 });
    }
    if (plan.teacher !== instructor.slug) {
      return Response.json({ error: 'That isn’t your project-meeting teacher.' }, { status: 409 });
    }

    // The moved event keeps its plan's length. Checked against the span the client sent so
    // a crafted request can't stretch a 30-min session into 90 minutes of calendar.
    const mins = Number(plan.minutes);
    const spanMins = Math.round(endTime.diff(startTime, 'minutes').minutes);
    if (spanMins !== mins) {
      return Response.json({ error: 'Meeting length mismatch.' }, { status: 400 });
    }

    // DESTINATION timing. Note both comparisons are done in LA: `startTime` is zoned above,
    // and the same-day test compares ISO calendar DATES rather than instants, so it stays
    // correct across the November DST shift and for a student browsing from another zone.
    const floor = projectRescheduleFloor(startTime, now);
    if (startTime < floor) {
      const sameDay = startTime.toISODate() === now.toISODate();
      return Response.json({
        error: sameDay
          ? `Same-day moves have to be ${SAME_DAY_EARLIEST_HOUR % 12 || 12}:00 PM or later, and at least 2 hours from now.`
          : 'Pick a time at least 2 hours from now.',
      }, { status: 400 });
    }

    // The plan's rolling horizon (this Saturday-week + next). canBookProjectOnDate isn't
    // used here on purpose: its 1/week cap would trip on this meeting's OWN row. The cap is
    // enforced below by projectRescheduleConflict, which excludes that row by id.
    const { start: hStart, end: hEnd } = projectHorizon(now);
    const dayISO = startTime.toISODate();
    if (dayISO < hStart.toISODate() || dayISO > hEnd.toISODate()) {
      return Response.json({
        error: 'You can move your weekly session within this week or next.',
      }, { status: 409 });
    }

    const hoursError = validateInstructorHours(instructor, startTime, mins);
    if (hoursError) return Response.json({ error: hoursError }, { status: 400 });

    // Instructor blocks (full-day and partial-window), same source the slot list uses.
    const blocks = await listBlocksForBooking();
    const blockSlugs = instructor.slug === 'art' ? ['art', 'aaron'] : [instructor.slug];
    if (blockSlugs.some((slug) => isDateBlocked(blocks, slug, dayISO))) {
      return Response.json({ error: `${instructor.displayName} isn’t available that day.` }, { status: 409 });
    }
    const blockedWindows = blockSlugs.flatMap((slug) => blockedWindowsForDate(blocks, slug, dayISO));
    if (blockedWindows.some((b) => startTime < b.end && endTime > b.start)) {
      return Response.json({ error: `${instructor.displayName} isn’t available at that time.` }, { status: 409 });
    }

    // Double-booking scan. The event being MOVED must not block its own new time —
    // without that, nudging a meeting 15 minutes later reports "just booked by someone
    // else". Every non-cancelled event conflicts, including ones Google marks Free:
    // Ryan blocks time off with all-day events and does not re-mark them (full reasoning
    // in getMonthAvailability — don't change one availability site alone).
    const conflictCheck = await calendar.events.list({
      calendarId: instructor.calendarId,
      timeMin: startTime.toISO(),
      timeMax: endTime.toISO(),
      singleEvents: true,
    });
    const conflicts = (conflictCheck.data.items || [])
      .filter((e) => e.status !== 'cancelled')
      .filter((e) => e.id !== eventId);
    if (conflicts.length > 0) {
      return Response.json({
        error: 'This slot was just booked by someone else. Please choose another time.',
      }, { status: 409 });
    }

    // The booking this event is supposed to own. Checked explicitly because
    // projectRescheduleConflict returns "no conflict" when it finds no active row — which
    // is right for a non-project event, but here it would wave through an ORPHAN: an event
    // carrying project extendedProperties with no live ledger row behind it (bookMeeting
    // leaves exactly that when its post-insert rollback delete fails). Moving an orphan
    // would update zero rows and still report success, parking a second real meeting in a
    // week the ledger believes is free.
    const ownRow = await loadActiveProjectBookingByEventId(eventId);
    if (!ownRow) {
      return Response.json({
        error: 'We can’t find that meeting in your session records — please cancel it and book a new time.',
      }, { status: 409 });
    }

    // The 1/week cap, pre-flighted BEFORE the calendar is touched, so a refused move
    // leaves calendar and ledger both untouched. Excludes this booking's own row by id.
    const capConflict = await projectRescheduleConflict(eventId, startTime);
    if (capConflict) return Response.json({ error: capConflict }, { status: 409 });

    const oldStartISO = ev.start?.dateTime;
    const currentEnd = DateTime.fromISO(ev.end?.dateTime || '').setZone(ZONE);
    if (!currentEnd.isValid) {
      return Response.json({ error: 'That meeting’s time looks malformed — please contact us.' }, { status: 409 });
    }

    await calendar.events.patch({
      calendarId: instructor.calendarId,
      eventId,
      requestBody: {
        start: { dateTime: startTime.toISO(), timeZone: ZONE },
        end: { dateTime: endTime.toISO(), timeZone: ZONE },
      },
    });

    // Ledger second — and if it fails, put the CALENDAR BACK. A stale ledger over a moved
    // event is not a cosmetic mismatch: week_start is the 1/week cap key, so the vacated
    // week reads as consumed and the occupied week reads as free, and the student can book
    // a SECOND session into the week they just moved into (the desync the admin route's
    // own comment cites, health note 2026-08-06 §1e). Rolling the event back restores the
    // exact pre-request state, which is the only state both stores agree on.
    try {
      await rescheduleProjectBookingByEventId(eventId, startTime);
    } catch (ledgerErr) {
      console.error('Project reschedule: ledger update failed, rolling calendar back:', ledgerErr);
      try {
        await calendar.events.patch({
          calendarId: instructor.calendarId,
          eventId,
          requestBody: {
            start: { dateTime: currentStart.toISO(), timeZone: ZONE },
            end: { dateTime: currentEnd.toISO(), timeZone: ZONE },
          },
        });
        return Response.json({
          error: 'Couldn’t move that meeting just now — it’s unchanged. Please try again.',
        }, { status: 503 });
      } catch (rollbackErr) {
        // Both stores are now out of step and no further automatic action is safe.
        console.error('Project reschedule: ROLLBACK FAILED — calendar and ledger disagree:', rollbackErr);
        return Response.json({
          error: 'Your meeting moved but our records didn’t update. Please contact us so we can fix it.',
        }, { status: 500 });
      }
    }

    try {
      await sendStudentRescheduleEmail({
        to: email,
        // Resolved here, AFTER every gate, so the Master read is paid only on a real move.
        // Non-fatal: the meeting has already moved, and a missing first name must never
        // turn a successful reschedule into an error.
        studentName: await studentNameFor(),
        instructorName: instructor.bodyName || instructor.displayName,
        oldStart: oldStartISO,
        newStart: startTime.toISO(),
        // The whole point of the 2-hour rule is the same-day move — which is exactly when
        // an uninformed instructor sits on Zoom at the old time. events.patch sends nothing
        // (no attendees on portal events, no sendUpdates), so this is the only notice.
        notify: [instructor.cancelEmail, instructor.bookingEmail].filter(Boolean),
        byStudent: true,
      });
    } catch (mailErr) {
      console.error('Project reschedule: confirmation email failed:', mailErr);
    }

    return Response.json({ success: true, start: startTime.toISO() });
  } catch (err) {
    console.error('rescheduleProjectMeeting failed:', err);
    return Response.json({ error: 'Could not reschedule that meeting.' }, { status: 500 });
  }
}
