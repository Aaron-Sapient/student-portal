// Pure rules for the standing weekly "project meeting" track — NO IO (luxon only),
// so it's unit-testable from plain Node ESM. lib/projectMeetings.js layers Supabase on
// top and re-exports everything here. See supabase/project_meetings.sql for the model.
//
// A project meeting is a standing weekly entitlement (one row in project_meeting_plans:
// teacher + fixed length + label), fully ADDITIVE to the senior essay cadence and the
// one-off track. The rules here answer two questions, both keyed off the portal's
// Saturday-anchored week (the same anchor as the essay cadence, so weeks line up):
//   • canBookProjectOnDate — is THIS date bookable for THIS plan right now?
//   • buildProjectCard     — the meetings-card/calendar view (window + booked state).

import { DateTime } from 'luxon';
import { ZONE, startOfSaturdayWeek } from './seniorsCore.js';

// Re-export the shared week math so consumers can import it from here too (the IO layer
// and tests pull ZONE / startOfSaturdayWeek off projectMeetingsCore).
export { ZONE, startOfSaturdayWeek } from './seniorsCore.js';

// The bookable horizon for a plan as of `now`: this Saturday-week through the END of
// the NEXT Saturday-week (a rolling two-week window). Two weeks — not one — so a visit
// late in the week (e.g. Friday, when 24h notice already pushes the earliest bookable
// day into next week) never strands the student with an empty calendar. The 1/week cap
// (below) still holds inside it, so the horizon lets them book ahead, never twice/week.
export function projectHorizon(now) {
  const start = startOfSaturdayWeek(now || DateTime.now());
  const end = start.plus({ weeks: 2 }).minus({ days: 1 }); // end of next Saturday-week
  return { start, end };
}

// The Saturday-anchored week of `dt` as a 'YYYY-MM-DD' key — the per-week cap bucket.
export function weekStartISO(dt) {
  return startOfSaturdayWeek(dt).toISODate();
}

// THE booking authorization for a project meeting (pure). `bookings` = the plan's ACTIVE
// project_meeting_bookings in the horizon ([{ week_start }] is all that's read). Layers
// the standing entitlement over: the horizon window, the teacher/length the plan is for,
// and the 1-per-Saturday-week cap. Returns { ok, reason }. Mirrors seniorsCore's
// canBookOnDate shape so the endpoints read the same way. The global 24h-advance check
// lives in the booking endpoints (as it does for seniors), not here.
export function canBookProjectOnDate(plan, dt, teacherSlug, mins, bookings, now) {
  if (!plan || plan.active === false) return { ok: false, reason: 'no-plan' };
  if (teacherSlug !== plan.teacher) return { ok: false, reason: 'wrong-teacher' };
  if (Number(mins) !== Number(plan.minutes)) return { ok: false, reason: 'bad-duration' };

  const day = dt.setZone(ZONE);
  const { start, end } = projectHorizon(now);
  const dayISO = day.toISODate();
  if (dayISO < start.toISODate() || dayISO > end.toISODate()) {
    return { ok: false, reason: 'out-of-window' };
  }

  // 1 active booking per Saturday-week. ISO dates sort lexicographically, so the
  // week_start string compare is exact.
  const wk = weekStartISO(day);
  if ((bookings || []).some((b) => b.status !== 'cancelled' && b.week_start === wk)) {
    return { ok: false, reason: 'week-booked' };
  }
  return { ok: true };
}

// The plan's meetings-card / calendar view: scan the horizon from tomorrow and collect
// the first/last day the rules still allow, so a fully-booked current week rolls the
// window forward to next week (and both-weeks-booked → no window → a "booked" card).
// Ignores instructor hours/busy on purpose (like buildSeniorBookingPlan) — the calendar
// endpoints surface the actual open slots; this answers "is it bookable at all, when".
export function buildProjectCard(plan, bookings, now) {
  const n = (now || DateTime.now()).setZone(ZONE);
  const earliest = n.plus({ days: 1 }).startOf('day');
  const { start, end } = projectHorizon(n);

  let firstDay = null;
  let lastDay = null;
  for (let cur = start; cur <= end; cur = cur.plus({ days: 1 })) {
    if (cur.endOf('day') < earliest) continue;
    if (canBookProjectOnDate(plan, cur, plan.teacher, plan.minutes, bookings, n).ok) {
      if (!firstDay) firstDay = cur;
      lastDay = cur;
    }
  }

  const thisWeek = weekStartISO(n);
  const bookedThisWeek = (bookings || []).some(
    (b) => b.status !== 'cancelled' && b.week_start === thisWeek
  );

  return {
    planId: plan.id,
    slug: plan.teacher,
    minutes: plan.minutes,
    durations: [plan.minutes],
    label: plan.label,
    bookable: !!firstDay,
    bookedThisWeek,
    window: firstDay ? { start: firstDay.toISODate(), end: lastDay.toISODate() } : null,
  };
}

// Cards for every active plan. `bookingsByPlanId` maps plan id → its active bookings.
export function buildProjectCards(plans, bookingsByPlanId, now) {
  return (plans || []).map((p) => buildProjectCard(p, bookingsByPlanId?.[p.id] || [], now));
}
