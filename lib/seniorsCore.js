// Pure senior-booking rules — NO IO (luxon only), so it's safe to import from
// plain Node ESM test scripts (lib/seniors.js layers Supabase + calendar on top
// and re-exports everything here). See lib/seniors.js for the full picture.
//
// "Week" is the portal's existing Saturday-anchored week (startOfSaturdayWeek),
// the same anchor as portalUtils.checkedInThisWeek / the ART reset — so the phase
// week, the per-week cap, and the check-in gate all line up.

import { DateTime } from 'luxon';

export const ZONE = 'America/Los_Angeles';
export const OTHER = { aaron: 'ryan', ryan: 'aaron' };

// Package rules — the AUTHORITATIVE source (the seniors table's meetings_per_week /
// meeting_minutes columns just mirror these into SQL).
//   essential     : a 30-minute weekly BUDGET — 1×30 OR 2×15 (student's choice)
//   comprehensive : 2×20 / week
//   vip           : 2×20 / week (a 3rd 20-min is added manually by the team, never self-booked)
export const PACKAGE_RULES = {
  essential: { label: 'Essential', budgetMin: 30, denominations: [30, 15], maxPerWeek: 2, note: '1×30-min or 2×15-min per week' },
  comprehensive: { label: 'Comprehensive', len: 20, denominations: [20], maxPerWeek: 2, note: '2×20-min per week' },
  vip: { label: 'VIP', len: 20, denominations: [20], maxPerWeek: 2, note: '2×20-min per week' },
};

// ── Week math ──────────────────────────────────────────────────────────────

// Most-recent-Saturday 00:00 LA for `dt` (the start of dt's booking week).
export function startOfSaturdayWeek(dt) {
  const d = (dt || DateTime.now()).setZone(ZONE);
  let sat = d.set({ weekday: 6 }); // Luxon: Sat = 6
  if (d.weekday < 6) sat = sat.minus({ weeks: 1 });
  return sat.startOf('day');
}

// Sheets hands a serial number (UNFORMATTED reads) or a string (FORMATTED reads).
export function parseSheetDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    const utc = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000), { zone: 'utc' });
    if (!utc.isValid) return null;
    return DateTime.fromObject({ year: utc.year, month: utc.month, day: utc.day }, { zone: ZONE });
  }
  let dt = DateTime.fromISO(String(raw), { zone: ZONE });
  if (!dt.isValid) dt = DateTime.fromJSDate(new Date(raw)).setZone(ZONE);
  return dt.isValid ? dt : null;
}

// Did the senior check in this (Saturday-anchored) week? `raw` = Master AY value.
export function checkedInThisWeek(raw, now) {
  const dt = parseSheetDate(raw);
  return !!dt && dt >= startOfSaturdayWeek(now);
}

// ── Check-in grant model (the auditable Supabase ledger; see lib/seniors.js) ──
// A weekly check-in GRANTS one week's worth of meetings, spendable across the
// current OR next Saturday-week so a late check-in never strands tokens. These
// pure helpers compute the window + token math; the IO layer persists the grant
// and consumption rows.

// The spending window for a grant created in the Saturday-week of `checkinTime`:
// from that week's Saturday through the END of the NEXT Saturday-week.
export function grantWindow(checkinTime) {
  const weekStart = startOfSaturdayWeek(checkinTime);
  const validThrough = weekStart.plus({ weeks: 2 }).minus({ days: 1 }); // end of next week (a date)
  return { weekStart, validThrough };
}

// Is meeting date `dt` inside this grant's window? `grant.week_start` /
// `grant.valid_through` are 'YYYY-MM-DD' LA calendar dates (ISO dates sort
// lexicographically, so string compare is correct).
export function meetingInWindow(dt, grant) {
  if (!grant) return false;
  const day = dt.setZone(ZONE).toISODate();
  return day >= grant.week_start && day <= grant.valid_through;
}

// Does a grant still have room for another `mins`-minute meeting, given the active
// usage already booked against it? Essential is budget-based (30-min weekly
// budget); vip/comprehensive are count-based (2 meetings).
export function grantHasRoom(grant, usage, mins) {
  if (grant.budget_minutes != null) return (usage.minutes || 0) + mins <= grant.budget_minutes;
  return (usage.count || 0) < grant.meeting_tokens;
}

// How many more meetings the grant can fund (Essential expressed in its SMALLEST
// denomination — 15-min slots — matching the existing display). `usage` = { count,
// minutes } of active bookings.
export function grantRemaining(grant, usage) {
  if (!grant) return 0;
  if (grant.budget_minutes != null) {
    // Smallest denomination for this package (Essential's 15-min slot), so a 30-min
    // budget reads as "2 meetings", not floor(30/20)=1. Falls back to 15 if the
    // grant predates the `package` column.
    const denom = Math.min(...(PACKAGE_RULES[grant.package]?.denominations || [15]));
    return Math.max(0, Math.floor((grant.budget_minutes - (usage.minutes || 0)) / denom));
  }
  return Math.max(0, grant.meeting_tokens - (usage.count || 0));
}

// ── Cross-meeting (the monthly secondary-teacher meeting) ────────────────────
// A grant CARRIES the once-a-month cross-meeting when its 2-week window includes
// the student's phase week — i.e. they checked in DURING the phase week OR the
// week before it (those are exactly the two check-in weeks whose window contains
// the phase week). When carried, the cross-meeting is bookable on ANY day in the
// window, not just phase-week days, so a late check-in never strands it. The
// window is two Saturday-weeks: week_start and the next one.

// The 'yyyy-LL' calendar month the cross-meeting belongs to for this grant: the
// month of whichever window week IS the phase week. null when the grant doesn't
// reach the phase week (so it carries no cross-meeting).
export function phaseWeekMonthKey(senior, grant) {
  if (!grant) return null;
  const w1 = DateTime.fromISO(grant.week_start, { zone: ZONE }); // a Saturday
  if (!w1.isValid) return null;
  const w2 = w1.plus({ weeks: 1 });
  for (const w of [w1, w2]) if (weekOfMonth(w) === senior.phase) return w.toFormat('yyyy-LL');
  return null;
}

export function grantCarriesCrossMeeting(senior, grant) {
  return phaseWeekMonthKey(senior, grant) != null;
}

// Is the once-a-month cross-meeting already booked? Enforced at the calendar-MONTH
// level (not per-grant), so a student who checks in two phase-adjacent weeks can't
// book two cross-meetings: `state.crossMeetings` is the student's active
// secondary-teacher meeting dates across ALL grants (the IO layer fills it). The
// current grant's own bookings are always counted too, so the rule holds even when
// crossMeetings isn't supplied (pure tests).
function crossMeetingDone(senior, grant, bookings, state) {
  const secondary = OTHER[senior.primary_teacher];
  if ((bookings || []).some((b) => b.teacher === secondary)) return true;
  const monthKey = phaseWeekMonthKey(senior, grant);
  if (!monthKey) return false;
  return (state?.crossMeetings || []).some((d) => String(d).slice(0, 7) === monthKey);
}

// The WEEKLY-cadence authorization (pure). `state` = { grant, bookings,
// crossMeetings? } where bookings is the active consumption rows for THIS grant
// and crossMeetings (optional) is the student's active cross-meeting dates across
// grants (for month-level once-a-month enforcement). Layers the grant gates
// (active, window, same-day) over the package rules: which teacher, which length,
// and — when the grant carries the monthly cross-meeting — CAPACITY RESERVATION
// that holds one slot for the secondary teacher (rather than forcing it first).
// Returns { ok, reason }. The exported canBookOnDate() below wraps this with the
// additive one-off track; this stays weekly-only so buildSeniorBookingPlan's
// cadence scan never mixes in one-offs.
function weeklyVerdict(senior, dt, teacherSlug, mins, state) {
  const { grant, bookings = [] } = state || {};
  if (!grant) return { ok: false, reason: 'no-grant' };
  if (!meetingInWindow(dt, grant)) return { ok: false, reason: 'out-of-window' };
  const day = dt.setZone(ZONE).toISODate();
  if (bookings.some((b) => b.meeting_date === day)) return { ok: false, reason: 'same-day' };

  const primary = senior.primary_teacher;
  const secondary = OTHER[primary];
  if (teacherSlug !== primary && teacherSlug !== secondary) return { ok: false, reason: 'wrong-teacher' };

  const rule = PACKAGE_RULES[senior.package];
  if (!rule.denominations.includes(mins)) return { ok: false, reason: 'bad-duration' };

  const usage = {
    count: bookings.length,
    minutes: bookings.reduce((a, b) => a + (b.minutes || 0), 0),
  };
  const isBudget = grant.budget_minutes != null; // Essential: a minute budget, not a token count
  const carries = grantCarriesCrossMeeting(senior, grant);
  const crossDone = crossMeetingDone(senior, grant, bookings, state);
  const crossOwed = carries && !crossDone;

  // The secondary teacher exists only as the monthly cross-meeting: only when the
  // grant carries it, and only once.
  if (teacherSlug === secondary) {
    if (!carries) return { ok: false, reason: 'wrong-teacher' };
    if (crossDone) return { ok: false, reason: 'secondary-done' };
    if (isBudget) {
      if (usage.minutes + mins > grant.budget_minutes) return { ok: false, reason: 'budget-used' };
    } else if (usage.count >= grant.meeting_tokens) {
      return { ok: false, reason: 'tokens-used' };
    }
    return { ok: true };
  }

  // Primary teacher — reserve room for an owed cross-meeting (capacity reservation,
  // NOT a hard "book the secondary first" lock: the two can be booked in any order).
  if (isBudget) {
    const reserve = crossOwed ? Math.min(...rule.denominations) : 0; // hold one slot for the cross
    if (usage.minutes + mins > grant.budget_minutes - reserve) {
      const overBudget = usage.minutes + mins > grant.budget_minutes;
      return { ok: false, reason: overBudget ? 'budget-used' : 'cross-reserved' };
    }
  } else {
    const cap = grant.meeting_tokens - (crossOwed ? 1 : 0);
    if (usage.count >= cap) {
      const noTokens = usage.count >= grant.meeting_tokens;
      return { ok: false, reason: noTokens ? 'tokens-used' : 'cross-reserved' };
    }
  }
  return { ok: true };
}

// ── One-off "extra meeting" track (separate from the weekly cadence) ──────────
// An admin can grant a senior ONE extra meeting (teacher + length + window) that
// lives OUTSIDE their deterministic weekly college-app cadence. These rows arrive
// in `state.oneoffs` (the IO layer fills it; pure tests omit it → no behavior
// change). A one-off only matches its exact teacher + length within its window.

// The active one-off (if any) that authorizes a (date, teacher, length) booking.
export function matchActiveOneoff(state, dt, teacherSlug, mins) {
  const day = dt.setZone(ZONE).toISODate();
  return (state?.oneoffs || []).find(
    (o) =>
      o.status === 'active' &&
      o.teacher === teacherSlug &&
      Number(o.minutes) === Number(mins) &&
      day >= o.valid_from &&
      day <= o.valid_through
  ) || null;
}

// THE booking authorization used by every gate (getMonthAvailability,
// getAvailableSlots, bookMeeting). The weekly cadence is tried FIRST, so a one-off
// is only ever spent on a meeting the weekly grant can't already cover — making it
// genuinely ADDITIVE, never a substitute for the normal weekly meetings. Returns
// { ok, reason } plus `via` ('weekly' | 'oneoff') and `oneoffId` so bookMeeting
// knows which ledger to charge.
export function canBookOnDate(senior, dt, teacherSlug, mins, state) {
  const weekly = weeklyVerdict(senior, dt, teacherSlug, mins, state);
  if (weekly.ok) return { ok: true, via: 'weekly' };
  const oneoff = matchActiveOneoff(state, dt, teacherSlug, mins);
  if (oneoff) return { ok: true, via: 'oneoff', oneoffId: oneoff.id };
  return weekly; // weekly's denial reason is the most informative message
}

// The active one-off grants as a display list for the booking plan: each bookable
// from max(valid_from, tomorrow) through valid_through. `now` = current LA time.
export function activeOneoffs(state, now) {
  const n = (now || DateTime.now()).setZone(ZONE);
  const earliest = n.plus({ days: 1 }).startOf('day');
  const out = [];
  for (const o of state?.oneoffs || []) {
    if (o.status !== 'active') continue;
    const from = DateTime.fromISO(o.valid_from, { zone: ZONE });
    const through = DateTime.fromISO(o.valid_through, { zone: ZONE });
    if (!from.isValid || !through.isValid) continue;
    const start = from < earliest ? earliest : from;
    if (start > through) continue; // window already closed
    out.push({
      id: o.id,
      slug: o.teacher,
      kind: 'oneoff',
      minutes: o.minutes,
      durations: [o.minutes],
      window: { start: start.toISODate(), end: through.toISODate() },
    });
  }
  return out;
}

// Which Saturday-anchored week of dt's calendar month is dt in? 1-based (1-5/6).
// week 1 = the week containing the 1st. A month can have a 5th (partial) week,
// which has no phase swap. A week straddling a month boundary is counted by the
// month of `dt` itself, so the assigned teacher is always computed per meeting date.
export function weekOfMonth(dt) {
  const d = dt.setZone(ZONE);
  const ws = startOfSaturdayWeek(d);
  const firstWeekStart = startOfSaturdayWeek(d.startOf('month'));
  const weeks = Math.round(ws.diff(firstWeekStart, 'days').days / 7);
  return weeks + 1;
}

// Display helper: is the week containing `dt` this senior's phase week, and who
// is primary/secondary? (Booking authorization lives in canBookOnDate, which keys
// the cross-meeting off the GRANT window, not a single week — this is only used
// for human-readable roster/debug output.)
export function assignedPlanForWeek(senior, dt) {
  const primary = senior.primary_teacher;
  const secondary = OTHER[primary];
  const rule = PACKAGE_RULES[senior.package];
  const isPhaseWeek = weekOfMonth(dt) === senior.phase;
  return { isPhaseWeek, primarySlug: primary, secondarySlug: secondary, secondaryRequired: isPhaseWeek, rule };
}

// ── Booking authorization (single source of truth) ───────────────────────────

// Durations a senior may still book with `teacherSlug` for a meeting on `dt`,
// given the live grant + bookings (`state` = { grant, bookings }).
export function bookableDurationsForDate(senior, dt, teacherSlug, state) {
  return PACKAGE_RULES[senior.package].denominations.filter(
    (d) => canBookOnDate(senior, dt, teacherSlug, d, state).ok
  );
}

// THE plan that drives every senior-facing surface (the meetings card AND the
// booking calendar), so they can never disagree. Pure: scans the grant window
// with canBookOnDate to find, per teacher, the bookable lengths and the first/
// last FUTURE day each is rule-eligible. (It ignores calendar busy/hours — the
// calendar endpoints surface actual open slots; this answers "is this teacher
// reachable at all within the grant, and in what window".) Returns slugs only;
// callers attach display names. `now` defaults to the current LA time.
export function buildSeniorBookingPlan(senior, now, state) {
  const n = (now || DateTime.now()).setZone(ZONE);
  const primary = senior.primary_teacher;
  const secondary = OTHER[primary];
  const rule = PACKAGE_RULES[senior.package];

  // The actual current Saturday-week (what "this week" really means), so the UI
  // can show the date range and stop implying a week the calendar can't book.
  const ws = startOfSaturdayWeek(n);
  const thisWeek = { start: ws.toISODate(), end: ws.plus({ days: 6 }).toISODate() };

  const grant = state?.grant || null;
  const bookings = state?.bookings || [];
  const usage = {
    count: bookings.length,
    minutes: bookings.reduce((a, b) => a + (b.minutes || 0), 0),
  };
  const remaining = grantRemaining(grant, usage);
  const carriesCross = grant ? grantCarriesCrossMeeting(senior, grant) : false;
  const crossDone = grant ? crossMeetingDone(senior, grant, bookings, state) : false;
  const crossOwed = carriesCross && !crossDone;

  const meetings = [];
  let grantWindowOut = null;
  if (grant) {
    const earliest = n.plus({ days: 1 }).startOf('day');
    const winStart = DateTime.fromISO(grant.week_start, { zone: ZONE });
    const winEnd = DateTime.fromISO(grant.valid_through, { zone: ZONE });
    grantWindowOut = { start: winStart.toISODate(), end: winEnd.toISODate() };
    for (const slug of [primary, secondary]) {
      let firstDay = null;
      let lastDay = null;
      const durs = new Set();
      let cur = winStart;
      while (cur <= winEnd) {
        if (cur.endOf('day') >= earliest) {
          for (const d of rule.denominations) {
            if (weeklyVerdict(senior, cur, slug, d, state).ok) {
              durs.add(d);
              if (!firstDay) firstDay = cur;
              lastDay = cur;
            }
          }
        }
        cur = cur.plus({ days: 1 });
      }
      if (durs.size) {
        meetings.push({
          slug,
          kind: slug === secondary ? 'cross' : 'primary',
          durations: rule.denominations.filter((d) => durs.has(d)),
          window: { start: firstDay.toISODate(), end: lastDay.toISODate() },
        });
      }
    }
  }

  return {
    package: senior.package,
    packageLabel: rule.label,
    packageNote: rule.note,
    denominations: rule.denominations,
    maxPerWeek: rule.maxPerWeek,
    phase: senior.phase,
    primarySlug: primary,
    secondarySlug: secondary,
    thisWeek,
    grantWindow: grantWindowOut,
    hasGrant: !!grant,
    remaining,
    carriesCross,
    crossOwed,
    crossDone,
    meetings,
    // Separate, additive one-off "extra meeting" grants (admin-issued). Rendered as
    // their own cards; bookable even when there's no weekly grant this week.
    oneoffs: activeOneoffs(state, n),
  };
}

// ── Pure data helpers for calendar counts ────────────────────────────────────

// Bucket fetched meetings into { weekStartISO -> { aaron:{count,minutes}, ryan:{} } }.
export function bucketByWeek(meetings) {
  const map = new Map();
  for (const m of meetings) {
    const key = startOfSaturdayWeek(m.start).toISODate();
    const wk = map.get(key) || { aaron: { count: 0, minutes: 0 }, ryan: { count: 0, minutes: 0 } };
    wk[m.slug].count += 1;
    wk[m.slug].minutes += m.minutes;
    map.set(key, wk);
  }
  return map;
}

export const emptyWeek = () => ({ aaron: { count: 0, minutes: 0 }, ryan: { count: 0, minutes: 0 } });

// Booked totals for the single week containing `dt`, from a list of meetings.
export function bookedForWeekOf(meetings, dt) {
  const key = startOfSaturdayWeek(dt).toISODate();
  return bucketByWeek(meetings).get(key) || emptyWeek();
}
