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
//   essential     : a 40-minute weekly BUDGET — 1×40 OR 2×20 (student's choice)
//   comprehensive : up to 2×30 / week
//   vip           : 2×30 / week (a 3rd is added manually by the team, never self-booked)
export const PACKAGE_RULES = {
  essential: { label: 'Essential', budgetMin: 40, denominations: [40, 20], maxPerWeek: 2, note: '1×40-min or 2×20-min per week' },
  comprehensive: { label: 'Comprehensive', len: 30, denominations: [30], maxPerWeek: 2, note: 'up to 2×30-min per week' },
  vip: { label: 'VIP', len: 30, denominations: [30], maxPerWeek: 2, note: '2×30-min per week' },
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

// A senior may only book inside the week their current check-in unlocks: the
// Saturday-anchored week containing `now`. Future weeks stay LOCKED until that
// week's own check-in is filed — the weekly check-in is the compliance gate, so a
// senior can't front-load several weeks of meetings in one sitting (and a stale
// past week isn't bookable either). `dt` = the meeting's date, `now` = LA time.
export function isCurrentBookingWeek(dt, now) {
  return (
    startOfSaturdayWeek(dt).toMillis() ===
    startOfSaturdayWeek(now || DateTime.now()).toMillis()
  );
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

// The per-teacher plan for the week containing `dt`.
//   non-phase week  -> primary gets the full allowance, secondary 0
//   phase week      -> secondary gets 1 (required, FIRST), primary gets max-1
export function assignedPlanForWeek(senior, dt) {
  const primary = senior.primary_teacher;
  const secondary = OTHER[primary];
  const rule = PACKAGE_RULES[senior.package];
  const isPhaseWeek = weekOfMonth(dt) === senior.phase;
  return { isPhaseWeek, primarySlug: primary, secondarySlug: secondary, secondaryRequired: isPhaseWeek, rule };
}

// ── Booking authorization (single source of truth) ───────────────────────────

function bookedFor(booked, slug) {
  return { count: booked?.[slug]?.count || 0, minutes: booked?.[slug]?.minutes || 0 };
}

// Can this senior book `durationMin` with `teacherSlug` for a meeting on `dt`,
// given what they've already booked in that meeting's week (`booked` =
// { aaron:{count,minutes}, ryan:{count,minutes} })? Returns { ok, reason }.
export function canBook(senior, dt, teacherSlug, durationMin, booked) {
  const plan = assignedPlanForWeek(senior, dt);
  const rule = plan.rule;
  const primary = plan.primarySlug;
  const secondary = plan.secondarySlug;

  if (teacherSlug !== primary && teacherSlug !== secondary) return { ok: false, reason: 'wrong-teacher' };
  if (!rule.denominations.includes(durationMin)) return { ok: false, reason: 'bad-duration' };

  const p = bookedFor(booked, primary);
  const s = bookedFor(booked, secondary);
  const isEssential = senior.package === 'essential';

  // Secondary teacher: only in the phase week, and exactly ONE cross-meeting.
  // Essential's weekly 40-min budget is enforced across BOTH teachers, so the
  // cross-meeting can only be a full 40 when nothing else is booked that week —
  // if a 20 is already on the books, only a 20 fits. This is intentional: the
  // budget is what the family paid for, so a student can't get 60 min by
  // splitting across teachers.
  if (teacherSlug === secondary) {
    if (!plan.isPhaseWeek) return { ok: false, reason: 'wrong-teacher' };
    if (s.count >= 1) return { ok: false, reason: 'secondary-done' };
    if (isEssential && p.minutes + s.minutes + durationMin > rule.budgetMin) return { ok: false, reason: 'budget-used' };
    return { ok: true };
  }

  // Primary teacher in a phase week is LOCKED until the cross-meeting is booked.
  if (plan.isPhaseWeek && s.count < 1) return { ok: false, reason: 'secondary-first' };

  if (isEssential) {
    if (p.minutes + s.minutes + durationMin > rule.budgetMin) return { ok: false, reason: 'budget-used' };
    return { ok: true };
  }
  // vip / comprehensive: count cap (one slot reserved for the cross-meeting in a phase week).
  const primaryCap = rule.maxPerWeek - (plan.isPhaseWeek ? 1 : 0);
  if (p.count >= primaryCap) return { ok: false, reason: 'week-full' };
  return { ok: true };
}

// Durations a senior may still book with `teacherSlug` for a meeting on `dt`.
export function bookableDurations(senior, dt, teacherSlug, booked) {
  return PACKAGE_RULES[senior.package].denominations.filter(
    (d) => canBook(senior, dt, teacherSlug, d, booked).ok
  );
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
