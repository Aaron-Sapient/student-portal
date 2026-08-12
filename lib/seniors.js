// Deterministic, token-free booking for the Class-of-2027 senior essay program.
//
// SERVER-ONLY — imports the service-role Supabase client. Never import into a
// client component; the meetings page gets senior data via /api/home-data.
//
// A senior's cadence is hardwired from three facts mirrored into the `seniors`
// table (see scripts/ingestSeniors.cjs): package, primary_teacher, phase.
//   • package      -> meetings/week and length
//   • primary      -> who they normally book with
//   • phase (1-4)  -> the week of the calendar month in which they MUST instead
//                     book exactly ONE meeting with the OTHER (secondary) teacher,
//                     booked FIRST; the rest of the week's allowance stays primary.
//
// The PURE rules (package math, week-of-month, canBookOnDate, the booking plan) live in
// lib/seniorsCore.js so they're unit-testable from plain Node; this file adds the
// Supabase roster lookups + Google-Calendar counting, and re-exports the core.

import { DateTime } from 'luxon';
import {
  getSupabaseClient,
  SENIORS_TABLE,
  SENIOR_CHECKIN_GRANTS,
  SENIOR_BOOKINGS,
  SENIOR_ONEOFF_GRANTS,
} from './supabase';
import { INSTRUCTORS } from './instructors';
import { belongsToStudent } from './calendarTitles.js';
import {
  ZONE,
  OTHER,
  startOfSaturdayWeek,
  bookedForWeekOf,
  grantWindow,
  carriedCrossMonth,
  PACKAGE_RULES,
  buildSeniorBookingPlan,
} from './seniorsCore';

// Re-export the pure API so callers can keep importing everything from '@/lib/seniors'.
export * from './seniorsCore';

// ── Roster lookups (cached) ──────────────────────────────────────────────────
// The whole table is 18 rows; cache it in-process with a short TTL and coalesce
// concurrent loads, same pattern as lib/identity.js's roster cache.
const SENIOR_CACHE_MS = 30 * 1000;
const cache = (globalThis.__seniorRosterCache ??= { at: 0, rows: null, inflight: null });

async function loadSeniors() {
  if (cache.rows && Date.now() - cache.at < SENIOR_CACHE_MS) return cache.rows;
  if (cache.inflight) return cache.inflight;
  cache.inflight = (async () => {
    try {
      const sb = getSupabaseClient();
      const { data, error } = await sb.from(SENIORS_TABLE).select('*').eq('active', true);
      if (error) throw error;
      cache.rows = data || [];
      cache.at = Date.now();
      return cache.rows;
    } finally {
      cache.inflight = null;
    }
  })();
  return cache.inflight;
}

// All active seniors (through the same short-TTL roster cache). Exposed for the
// compliance-outreach crons, which need the whole roster, not a single lookup.
export async function getActiveSeniors() {
  return loadSeniors();
}

export async function getSeniorByEmail(email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  const rows = await loadSeniors();
  return rows.find((r) => String(r.student_email || '').trim().toLowerCase() === target) || null;
}

export async function getSeniorBySheetId(sheetId) {
  if (!sheetId) return null;
  const rows = await loadSeniors();
  return rows.find((r) => r.student_sheet_id === sheetId) || null;
}

// ── Calendar counting (deterministic enforcement) ────────────────────────────
// The per-week cap is enforced by counting the senior's LIVE calendar events, so
// cancel/reschedule self-correct. A senior's portal bookings carry
// extendedProperties.private.studentEmail (authoritative); the title-name match
// is a fallback for anything logged by hand.

export async function fetchSeniorMeetings(calendar, senior, timeMinISO, timeMaxISO) {
  const email = String(senior.student_email || '').toLowerCase();
  const nameLc = String(senior.student_name || '').toLowerCase().trim();
  const out = [];
  for (const slug of ['aaron', 'ryan']) {
    const calendarId = INSTRUCTORS[slug].calendarId;
    if (!calendarId) continue;
    let items = [];
    try {
      const res = await calendar.events.list({
        calendarId,
        timeMin: timeMinISO,
        timeMax: timeMaxISO,
        singleEvents: true,
        orderBy: 'startTime',
      });
      items = res.data.items || [];
    } catch {
      continue; // a calendar read failure degrades to "nothing booked there"
    }
    for (const e of items) {
      if (e.status === 'cancelled') continue;
      const pep = e.extendedProperties?.private || {};
      // Provenance first, title second. A title-only match must still clear the
      // parent-meeting rule: "Ryan-<Student> Parents" contains the student's name,
      // and counting it here would spend one of their weekly meetings on a meeting
      // they were never in. See lib/calendarTitles.js for why the authoritative
      // branch is exempt (a student-typed "parent" agenda must not escape the cap).
      const authoritative = !!pep.studentEmail && pep.studentEmail.toLowerCase() === email;
      const titleMatch = !!(nameLc && e.summary && e.summary.toLowerCase().includes(nameLc));
      const mine = authoritative || (titleMatch && belongsToStudent({ summary: e.summary }));
      if (!mine) continue;
      const start = DateTime.fromISO(e.start?.dateTime || e.start?.date).setZone(ZONE);
      const end = DateTime.fromISO(e.end?.dateTime || e.end?.date).setZone(ZONE);
      out.push({
        slug,
        eventId: e.id,
        start,
        end,
        minutes: start.isValid && end.isValid ? Math.round(end.diff(start, 'minutes').minutes) : 0,
      });
    }
  }
  return out;
}

// Fetch + total the senior's bookings for the (Saturday-anchored) week of `dt`.
export async function countBookedForWeek(calendar, senior, dt) {
  const ws = startOfSaturdayWeek(dt);
  const meetings = await fetchSeniorMeetings(calendar, senior, ws.toISO(), ws.plus({ weeks: 1 }).toISO());
  return bookedForWeekOf(meetings, dt);
}

// ── Check-in token ledger (Supabase — the auditable source of truth) ─────────
// A check-in writes a GRANT (one week's worth, windowed across current+next week);
// each booking writes a CONSUMPTION row linked to that grant + its calendar event.
// Authorization reads these rows (NOT live calendar counts) so it's auditable.

// Create the grant for a senior's weekly check-in; supersede any prior active grant
// (one active grant at a time → use-it-or-lose-it). `now` = the check-in DateTime.
// The month ('yyyy-LL') of a cross-meeting the OUTGOING grant still owes and the
// incoming one wouldn't otherwise carry — i.e. the entitlement a supersede would
// silently destroy. null (the normal case) when nothing is owed.
//
// Deliberately scoped by getActiveGrant, which only returns a grant whose window
// still covers today: a grant that lapsed on its own before the next check-in is
// use-it-or-lose-it working as designed and is NEVER carried. Measured 2026-08-11 —
// 4 real losses since June vs 9 by-design expiries, so this must not catch the latter.
// Never throws: a check-in must still succeed if this lookup fails.
async function pendingCrossMonth(senior, incoming) {
  try {
    // getActiveGrant only returns a grant whose window still covers today, so a grant
    // that lapsed on its own before this check-in is never carried.
    const outgoing = await getActiveGrant(senior.student_sheet_id);
    if (!outgoing) return null;

    const sb = getSupabaseClient();
    const secondary = OTHER[senior.primary_teacher];
    const { data: booked } = await sb
      .from(SENIOR_BOOKINGS)
      .select('meeting_date, grant_id')
      .eq('student_sheet_id', senior.student_sheet_id)
      .eq('teacher', secondary)
      .eq('status', 'active');

    // SPENT-CHECK, two ways, because neither alone is sufficient:
    //  • by grant — the outgoing grant already funded a secondary meeting. Required
    //    because a grant window straddles month boundaries, so that meeting's DATE can
    //    fall in a different month than the entitlement it spent; matching on month
    //    alone would miss it and re-issue a cross the student already took.
    //  • by month — catches a cross booked under an earlier grant for the same month.
    if ((booked || []).some((r) => r.grant_id === outgoing.id)) return null;
    const bookedSecondaryMonths = (booked || []).map((r) => String(r.meeting_date).slice(0, 7));

    return carriedCrossMonth(
      senior,
      outgoing,
      { week_start: incoming.weekStart.toISODate(), valid_through: incoming.validThrough.toISODate() },
      bookedSecondaryMonths,
      incoming.at
    );
  } catch (e) {
    console.warn('[senior] cross-meeting carry-over check failed (grant still created):', e?.message || e);
    return null;
  }
}

export async function createCheckinGrant(senior, now) {
  const sb = getSupabaseClient();
  const at = (now || DateTime.now()).setZone(ZONE);
  const { weekStart, validThrough } = grantWindow(at);
  const rule = PACKAGE_RULES[senior.package];
  const isEssential = senior.package === 'essential';
  // Resolved BEFORE the supersede — it reads the grant that is about to be retired.
  const crossMonthOverride = await pendingCrossMonth(senior, { weekStart, validThrough, at });
  await sb
    .from(SENIOR_CHECKIN_GRANTS)
    .update({ active: false })
    .eq('student_sheet_id', senior.student_sheet_id)
    .eq('active', true);
  const { data, error } = await sb
    .from(SENIOR_CHECKIN_GRANTS)
    .insert({
      student_sheet_id: senior.student_sheet_id,
      student_email: senior.student_email,
      week_start: weekStart.toISODate(),
      valid_through: validThrough.toISODate(),
      package: senior.package,
      meeting_tokens: isEssential ? 0 : rule.maxPerWeek,
      budget_minutes: isEssential ? rule.budgetMin : null,
      cross_month_override: crossMonthOverride,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// The senior's current grant: active (not superseded by a newer check-in) AND not
// expired (its window still covers today). Either condition failing → null, which
// means "check in to unlock booking."
export async function getActiveGrant(studentSheetId) {
  const sb = getSupabaseClient();
  const today = DateTime.now().setZone(ZONE).toISODate();
  const { data } = await sb
    .from(SENIOR_CHECKIN_GRANTS)
    .select('*')
    .eq('student_sheet_id', studentSheetId)
    .eq('active', true)
    .gte('valid_through', today)
    .order('valid_through', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

// Everything canBookOnDate / the displays need in one read: the active grant, its
// active consumption rows ([{ teacher, minutes, meeting_date }]), and the
// student's active cross-meetings across ALL grants for the current + next
// calendar month (so "one cross-meeting per month" is enforced even across two
// phase-adjacent check-ins). Takes the senior row (needs the secondary teacher).
// `excludeEventId` — RESCHEDULE support. A reschedule re-authorizes a meeting that
// is being MOVED, not added, so the meeting's own consumption must not count against
// the student while its new date is checked. Without this, a senior who has spent
// their grant can never reschedule anything: the gate answers 'tokens-used' (or
// 'same-day' for a same-day move, or 'secondary-done' for a cross-meeting) and
// getAvailableSlots returns an empty day, every day.
//
// It must filter BOTH usage sources — `bookings` (this grant's consumption) AND
// `crossMeetings` (the month-level once-a-month check, which is a SEPARATE query and
// would otherwise still see the meeting being moved). One-offs are handled in
// loadSeniorOneoffs, which rehydrates the one that funded the moving meeting.
export async function loadSeniorBookingState(senior, excludeEventId = null) {
  const studentSheetId = senior.student_sheet_id;
  const sb = getSupabaseClient();
  const secondary = OTHER[senior.primary_teacher];
  const now = DateTime.now().setZone(ZONE);
  const { data: crossRows } = await sb
    .from(SENIOR_BOOKINGS)
    .select('meeting_date, calendar_event_id')
    .eq('student_sheet_id', studentSheetId)
    .eq('teacher', secondary)
    .eq('status', 'active')
    .gte('meeting_date', now.startOf('month').toISODate())
    .lte('meeting_date', now.plus({ months: 1 }).endOf('month').toISODate());
  const crossMeetings = (crossRows || [])
    .filter((r) => !excludeEventId || r.calendar_event_id !== excludeEventId)
    .map((r) => r.meeting_date);

  // Active one-off "extra meeting" grants (the separate, additive track). Loaded
  // alongside the weekly grant so every gate (canBookOnDate) and the booking plan
  // can authorize/surface them. Independent of the weekly grant — present even when
  // the student hasn't checked in this week.
  const oneoffs = await loadSeniorOneoffs(studentSheetId, excludeEventId);

  const grant = await getActiveGrant(studentSheetId);
  if (!grant) return { grant: null, bookings: [], crossMeetings, oneoffs };
  const { data } = await sb
    .from(SENIOR_BOOKINGS)
    .select('teacher, minutes, meeting_date, calendar_event_id')
    .eq('grant_id', grant.id)
    .eq('status', 'active');
  const bookings = (data || []).filter(
    (b) => !excludeEventId || b.calendar_event_id !== excludeEventId
  );
  return { grant, bookings, crossMeetings, oneoffs };
}

// ── One-off "extra meeting" ledger (the separate, additive senior track) ─────
// Admin-issued: one extra meeting with a chosen teacher/length, bookable in a
// window, OUTSIDE the deterministic weekly cadence. See supabase/senior_oneoff_grants.sql.

// The student's active (un-spent, un-cancelled) one-off grants.
//
// `excludeEventId` (reschedule) additionally REHYDRATES the one-off that funded the
// meeting being moved: it is 'consumed' and pointing at that event, so without this
// a one-off-funded meeting could never be rescheduled (the weekly grant has no room
// — that is why it was a one-off — and matchActiveOneoff skips consumed rows). It is
// surfaced as 'active' but tagged `rehydratedFrom`, so bookMeeting re-points it to the
// new event rather than double-spending. See bookMeeting's senior consumption block.
export async function loadSeniorOneoffs(studentSheetId, excludeEventId = null) {
  const sb = getSupabaseClient();
  const { data } = await sb
    .from(SENIOR_ONEOFF_GRANTS)
    .select('id, teacher, minutes, valid_from, valid_through, status, calendar_event_id')
    .eq('student_sheet_id', studentSheetId)
    .in('status', excludeEventId ? ['active', 'consumed'] : ['active']);
  const rows = data || [];
  if (!excludeEventId) return rows;
  return rows
    .filter((o) => o.status === 'active' || o.calendar_event_id === excludeEventId)
    .map((o) =>
      o.status === 'consumed' ? { ...o, status: 'active', rehydratedFrom: excludeEventId } : o
    );
}

// Issue a one-off grant. `window` = { from, through } LA ISO dates (inclusive).
export async function createOneoffGrant(senior, { teacher, minutes, from, through, note, grantedBy }) {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from(SENIOR_ONEOFF_GRANTS)
    .insert({
      student_sheet_id: senior.student_sheet_id,
      student_email: senior.student_email,
      teacher,
      minutes,
      valid_from: from,
      valid_through: through,
      note: note || null,
      granted_by: grantedBy || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Spend a one-off on a booked event (called after the calendar event is created).
export async function consumeOneoff(oneoffId, eventId) {
  const sb = getSupabaseClient();
  const { error } = await sb
    .from(SENIOR_ONEOFF_GRANTS)
    .update({ status: 'consumed', calendar_event_id: eventId })
    .eq('id', oneoffId)
    .eq('status', 'active');
  if (error) throw error;
}

// Re-point a consumed one-off from the meeting being rescheduled to its replacement,
// WITHOUT returning it to the student. Status stays 'consumed' throughout, so the
// one-off is never spendable twice; and because the row no longer references the old
// event, the cancel that follows the rebook won't hand it back (cancelOneoffByEventId
// matches on calendar_event_id). Throws if the row isn't in the expected state — the
// caller rolls the new booking back rather than leave it uncharged.
export async function reconsumeOneoff(oneoffId, oldEventId, newEventId) {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from(SENIOR_ONEOFF_GRANTS)
    .update({ calendar_event_id: newEventId })
    .eq('id', oneoffId)
    .eq('calendar_event_id', oldEventId)
    .eq('status', 'consumed')
    .select('id');
  if (error) throw error;
  if (!data?.length) throw new Error(`one-off ${oneoffId} could not be re-pointed from ${oldEventId}`);
}

// Return a one-off to the student: a consumed one-off whose event is cancelled goes
// back to 'active' (event cleared). No-op if the event wasn't a one-off booking, so
// it's safe to call unconditionally on any cancel.
export async function cancelOneoffByEventId(eventId) {
  const sb = getSupabaseClient();
  await sb
    .from(SENIOR_ONEOFF_GRANTS)
    .update({ status: 'active', calendar_event_id: null })
    .eq('calendar_event_id', eventId)
    .eq('status', 'consumed');
}

// Record a booking against its grant. `dt` = meeting DateTime.
export async function recordBooking(grant, { eventId, teacher, dt, minutes, studentSheetId }) {
  const sb = getSupabaseClient();
  const { error } = await sb.from(SENIOR_BOOKINGS).insert({
    grant_id: grant.id,
    student_sheet_id: studentSheetId,
    calendar_event_id: eventId,
    teacher,
    meeting_date: dt.setZone(ZONE).toISODate(),
    minutes,
  });
  if (error) throw error;
}

// Return a token: mark the consumption row cancelled. No-op if the event isn't a
// senior booking (so it's safe to call unconditionally on any cancel).
export async function cancelBookingByEventId(eventId) {
  const sb = getSupabaseClient();
  await sb
    .from(SENIOR_BOOKINGS)
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('calendar_event_id', eventId)
    .eq('status', 'active');
}

// Move a booking to a new date (admin reschedule). No-op for non-senior events.
export async function rescheduleBookingByEventId(eventId, newDt) {
  const sb = getSupabaseClient();
  await sb
    .from(SENIOR_BOOKINGS)
    .update({ meeting_date: newDt.setZone(ZONE).toISODate() })
    .eq('calendar_event_id', eventId)
    .eq('status', 'active');
}

// The senior booking plan, decorated with instructor display names (the pure
// builder in seniorsCore returns slugs only). This is what the meetings card and
// the booking calendar both read, so they can never diverge.
export function seniorBookingPlan(senior, now, state) {
  const plan = buildSeniorBookingPlan(senior, now, state);
  const name = (slug) => INSTRUCTORS[slug]?.displayName || slug;
  return {
    ...plan,
    primaryName: name(plan.primarySlug),
    secondaryName: name(plan.secondarySlug),
    meetings: plan.meetings.map((m) => ({ ...m, name: name(m.slug) })),
    oneoffs: (plan.oneoffs || []).map((o) => ({ ...o, name: name(o.slug) })),
  };
}
