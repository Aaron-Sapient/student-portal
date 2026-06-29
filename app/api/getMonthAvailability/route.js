import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { getInstructor } from '@/lib/instructors';
import { listBlocksForBooking, isDateBlocked, blockedWindowsForDate } from '@/lib/blocks';
import {
  getSeniorByEmail,
  loadSeniorBookingState,
  canBookOnDate,
  phaseWeekMonthKey,
  weekOfMonth,
  OTHER,
} from '@/lib/seniors';
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

export async function GET(request) {
  const { sessionClaims } = await auth();
  if (!sessionClaims?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // `month` is 0-indexed to match JS Date / the booking page's calMonth state.
  const monthParam = parseInt(searchParams.get('month'));
  const yearParam = parseInt(searchParams.get('year'));
  const duration = parseInt(searchParams.get('duration') || '30');
  const instructor = getInstructor(searchParams.get('instructor'));

  if (Number.isNaN(monthParam) || Number.isNaN(yearParam)) {
    return Response.json({ error: 'Missing month or year' }, { status: 400 });
  }

  const zone = 'America/Los_Angeles';
  const monthStart = DateTime.fromObject(
    { year: yearParam, month: monthParam + 1, day: 1 },
    { zone }
  );
  const monthEnd = monthStart.endOf('month');

  // The booking grid renders trailing/leading days from adjacent months (e.g. June 1–5
  // shown in the May view), so compute availability across the whole visible grid —
  // the Sunday on/before the 1st through the Saturday on/after the last day. Luxon
  // weekdays are Mon=1…Sun=7; the calendar week starts on Sunday.
  const gridStart = monthStart.minus({ days: monthStart.weekday % 7 });
  const gridEnd = monthEnd.plus({ days: (6 - monthEnd.weekday + 7) % 7 });

  const now = DateTime.now().setZone(zone);
  const earliestAllowed = now.plus({ days: 1 });

  try {
    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Project-meeting gate (deep-linked ?m=project:<id>): authorize days against the
    // standing plan + 1/week ledger, NOT the senior essay gate. Resolved first so a
    // senior's project booking with their essay teacher uses the project window/cap.
    const mKey = searchParams.get('m') || '';
    const projectPlanId = mKey.startsWith('project:') ? mKey.slice('project:'.length) : null;
    let projectPlan = null;
    let projectBookings = null;
    if (projectPlanId) {
      projectPlan = await loadProjectPlanForBooking(sessionClaims.email, projectPlanId);
      if (!projectPlan || projectPlan.teacher !== instructor.slug) {
        return Response.json({ availableDates: [], phaseWeek: null });
      }
      projectBookings = await loadProjectBookingsForPlan(projectPlanId, now);
    }

    // Senior gate: a day is bookable only if the check-in token ledger allows a
    // meeting that day (active grant → window → same-day → tokens → teacher/length/
    // phase). Load the ledger state once; each day's check is pure/in-memory.
    // Skipped entirely for a project booking (its own gate runs in the day loop).
    const senior = projectPlanId ? null : await getSeniorByEmail(sessionClaims.email);
    let seniorState = null;
    // The viewed month's cross-meeting week, as {start,end} ISO — colored ONLY on
    // the secondary teacher's calendar (the one this cross-meeting is actually
    // with), when this grant carries the cross-meeting (its window reaches the
    // phase week) and we're viewing that month. On the primary calendar the week
    // carries no special meaning, so we leave it out. We derive it from the booking
    // logic's OWN helpers (phaseWeekMonthKey/weekOfMonth) so the gold highlight can
    // never contradict what the rules will let you book.
    let phaseWeek = null;
    if (senior) {
      seniorState = await loadSeniorBookingState(senior);
      // A separate one-off grant makes this teacher bookable even with no weekly
      // grant this week — so only bail when there's neither.
      const hasOneoff = (seniorState.oneoffs || []).some(
        (o) => o.status === 'active' && o.teacher === instructor.slug
      );
      if (!seniorState.grant && !hasOneoff) return Response.json({ availableDates: [], phaseWeek: null });
      if (seniorState.grant) {
        const isCrossCalendar = instructor.slug === OTHER[senior.primary_teacher];
        const monthKey = phaseWeekMonthKey(senior, seniorState.grant);
        if (isCrossCalendar && monthKey && monthKey === monthStart.toFormat('yyyy-LL')) {
          let pwStart = null;
          let pwEnd = null;
          for (let d = monthStart; d <= monthEnd; d = d.plus({ days: 1 })) {
            if (weekOfMonth(d) === senior.phase) {
              if (!pwStart) pwStart = d;
              pwEnd = d;
            }
          }
          if (pwStart) phaseWeek = { start: pwStart.toISODate(), end: pwEnd.toISODate() };
        }
      }
    }

    // Mirror getAvailableSlots: an Aaron block also blocks ART since they share a calendar.
    const blockSlugs = instructor.slug === 'art' ? ['art', 'aaron'] : [instructor.slug];

    const [eventsRes, blocks] = await Promise.all([
      calendar.events.list({
        calendarId: instructor.calendarId,
        timeMin: gridStart.startOf('day').toISO(),
        timeMax: gridEnd.endOf('day').toISO(),
        singleEvents: true,
        orderBy: 'startTime',
      }),
      listBlocksForBooking(sheets).catch(() => []),
    ]);

    const busyWindows = (eventsRes.data.items || [])
      .filter(e => e.status !== 'cancelled')
      .map(e => ({
        start: DateTime.fromISO(e.start.dateTime || e.start.date),
        end: DateTime.fromISO(e.end.dateTime || e.end.date),
      }));

    const availableDates = [];
    let cursor = gridStart;
    while (cursor <= gridEnd) {
      const dateStr = cursor.toFormat('yyyy-LL-dd');
      const hours = instructor.hoursByWeekday[cursor.weekday];

      // Project: skip any day outside the plan's window or already booked this week.
      // Else seniors: skip any day the token ledger won't authorize (out of the grant
      // window, same-day collision, tokens used, wrong teacher/length/phase).
      if (projectPlanId) {
        if (!canBookProjectOnDate(projectPlan, cursor, instructor.slug, duration, projectBookings, now).ok) {
          cursor = cursor.plus({ days: 1 });
          continue;
        }
      } else if (senior) {
        if (!canBookOnDate(senior, cursor, instructor.slug, duration, seniorState).ok) {
          cursor = cursor.plus({ days: 1 });
          continue;
        }
      }

      if (
        hours &&
        cursor.endOf('day') >= earliestAllowed &&
        !blockSlugs.some(slug => isDateBlocked(blocks, slug, dateStr))
      ) {
        // Partial-time blocks apply per-day, so fold them into this day's busy set.
        const dayBusy = [...busyWindows];
        for (const slug of blockSlugs) {
          dayBusy.push(...blockedWindowsForDate(blocks, slug, dateStr));
        }

        let pointer = cursor.set({ hour: hours.start, minute: 0, second: 0, millisecond: 0 });
        const limit = cursor.set({ hour: hours.end, minute: 0, second: 0, millisecond: 0 });

        while (pointer < limit) {
          const slotEnd = pointer.plus({ minutes: duration });
          if (slotEnd > limit) break;
          if (pointer >= earliestAllowed) {
            const conflict = dayBusy.some(b => pointer < b.end && slotEnd > b.start);
            if (!conflict) {
              availableDates.push(dateStr);
              break;
            }
          }
          pointer = pointer.plus({ minutes: duration });
        }
      }

      cursor = cursor.plus({ days: 1 });
    }

    return Response.json({ availableDates, phaseWeek });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
