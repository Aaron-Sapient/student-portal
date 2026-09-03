import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { getInstructor } from '@/lib/instructors';
import { teachingRunMinutes } from '@/lib/teachingGuardrails';
import { computeDayAvailability } from '@/lib/bookingSlots';
import { getSeniorByEmail, loadSeniorBookingState, canBookOnDate } from '@/lib/seniors';
import { resolveRescheduleTarget } from '@/lib/rescheduleTarget';
import {
  loadProjectPlanForBooking,
  loadProjectBookingsForPlan,
  canBookProjectOnDate,
} from '@/lib/projectMeetings';

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

/* generateSlots and the whole day-availability computation moved to
   lib/bookingSlots.js on 2026-09-03, unchanged. The per-lead page
   (/next/<slug>) offers families real times on the same calendar and has to get
   the same answer this route gives; a second copy would diverge on its first
   divergent day and nobody would see it until someone tapped a time and was
   refused. The gates below (senior, project, reschedule) stayed here: they are
   about a signed-in student's entitlement, which the lead route has none of. */

// Recommendation order. Used to give +100 to back-to-back slots, which steered students
// into stacking the day solid (Fri 2026-08-28: 4:00–8:00 with no break). For capped
// instructors the SHORTEST resulting teaching run ranks first; ties keep slot order.
// Instructors WITHOUT a cap (Ryan) keep the original consolidate-the-day ranking.
function scoreSlots(availableSlots, calendarEvents, busyWindows, instructor) {
  if (!Number.isFinite(instructor.maxTeachingRunMinutes)) {
    return availableSlots.map(slot => {
      const slotStart = DateTime.fromISO(slot.start);
      const slotEnd = DateTime.fromISO(slot.end);
      let score = 0;
      const isBackToBack = busyWindows.some(busy =>
        slotStart.equals(busy.end) || slotEnd.equals(busy.start)
      );
      if (isBackToBack) score += 100;
      score += busyWindows.length;
      return { ...slot, score };
    });
  }
  const gap = Number.isFinite(instructor.teachingRunGapMinutes) ? instructor.teachingRunGapMinutes : 15;
  return availableSlots.map(slot => {
    const candidate = { start: DateTime.fromISO(slot.start), end: DateTime.fromISO(slot.end) };
    return { ...slot, score: -teachingRunMinutes(candidate, calendarEvents, gap) };
  });
}

export async function GET(request) {
  const { sessionClaims } = await auth();
  if (!sessionClaims?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const dateStr = searchParams.get('date');
  const duration = parseInt(searchParams.get('duration') || '30');
  const instructor = getInstructor(searchParams.get('instructor'));
  // Reschedule: the meeting being MOVED must not count against the student while we
  // check where it can go — neither in the senior gate below nor as a busy window on
  // its own calendar. Without it the gate answers tokens-used/same-day/secondary-done
  // and every candidate day comes back empty.
  const excludeEventId = searchParams.get('excludeEventId') || null;

  if (!dateStr) {
    return Response.json({ error: 'Missing date parameter' }, { status: 400 });
  }

  const requestedDate = DateTime.fromISO(dateStr, { zone: 'America/Los_Angeles' });
  const now = DateTime.now().setZone('America/Los_Angeles');
  const earliestAllowed = now.plus({ days: 1 });

  try {
    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    // No Sheets client here anymore — instructor blocks moved to Supabase (2026-08-09)
    // and this route reads nothing else from the Master Sheet.

    // Verify the reschedule target before it is allowed to suppress anything. Slots are
    // only a display, but showing times the booking gate will refuse is its own bug —
    // and this keeps the two in agreement by construction. Unverified → null → the day
    // is scored exactly as it would be without an exclusion.
    const replacingEventId = await resolveRescheduleTarget(
      calendar, instructor, excludeEventId, sessionClaims.email, null, now
    );

    // Project-meeting gate (deep-linked ?m=project:<id>): authorize this date against
    // the standing plan + 1/week ledger. Else the senior essay gate. (One or the other —
    // a project booking is never run through the essay gate, even for a senior.)
    const mKey = searchParams.get('m') || '';
    const projectPlanId = mKey.startsWith('project:') ? mKey.slice('project:'.length) : null;
    if (projectPlanId) {
      const plan = await loadProjectPlanForBooking(sessionClaims.email, projectPlanId);
      if (!plan || plan.teacher !== instructor.slug) {
        return Response.json({ slots: [], recommendations: [], unavailable: true });
      }
      const bookings = await loadProjectBookingsForPlan(projectPlanId, now);
      if (!canBookProjectOnDate(plan, requestedDate, instructor.slug, duration, bookings, now).ok) {
        return Response.json({ slots: [], recommendations: [], unavailable: true });
      }
    } else {
      const senior = await getSeniorByEmail(sessionClaims.email);
      if (senior) {
        const state = await loadSeniorBookingState(senior, replacingEventId);
        if (!canBookOnDate(senior, requestedDate, instructor.slug, duration, state).ok) {
          return Response.json({ slots: [], recommendations: [], unavailable: true });
        }
      }
    }

    const { blocked, slots: available, calendarEvents, busyWindows } = await computeDayAvailability({
      calendar,
      instructor,
      dateStr,
      duration,
      earliestAllowed,
      replacingEventId,
    });

    if (blocked) {
      return Response.json({ slots: [], recommendations: [], blocked: true });
    }

    const scored = scoreSlots(available, calendarEvents, busyWindows, instructor);
    const recommendations = [...scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return Response.json({
      slots: available,
      recommendations,
    });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
