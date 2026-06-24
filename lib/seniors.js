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
import {
  ZONE,
  OTHER,
  startOfSaturdayWeek,
  bookedForWeekOf,
  grantWindow,
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
      const mine =
        (pep.studentEmail && pep.studentEmail.toLowerCase() === email) ||
        (nameLc && e.summary && e.summary.toLowerCase().includes(nameLc));
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
export async function createCheckinGrant(senior, now) {
  const sb = getSupabaseClient();
  const { weekStart, validThrough } = grantWindow((now || DateTime.now()).setZone(ZONE));
  const rule = PACKAGE_RULES[senior.package];
  const isEssential = senior.package === 'essential';
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
export async function loadSeniorBookingState(senior) {
  const studentSheetId = senior.student_sheet_id;
  const sb = getSupabaseClient();
  const secondary = OTHER[senior.primary_teacher];
  const now = DateTime.now().setZone(ZONE);
  const { data: crossRows } = await sb
    .from(SENIOR_BOOKINGS)
    .select('meeting_date')
    .eq('student_sheet_id', studentSheetId)
    .eq('teacher', secondary)
    .eq('status', 'active')
    .gte('meeting_date', now.startOf('month').toISODate())
    .lte('meeting_date', now.plus({ months: 1 }).endOf('month').toISODate());
  const crossMeetings = (crossRows || []).map((r) => r.meeting_date);

  // Active one-off "extra meeting" grants (the separate, additive track). Loaded
  // alongside the weekly grant so every gate (canBookOnDate) and the booking plan
  // can authorize/surface them. Independent of the weekly grant — present even when
  // the student hasn't checked in this week.
  const oneoffs = await loadSeniorOneoffs(studentSheetId);

  const grant = await getActiveGrant(studentSheetId);
  if (!grant) return { grant: null, bookings: [], crossMeetings, oneoffs };
  const { data } = await sb
    .from(SENIOR_BOOKINGS)
    .select('teacher, minutes, meeting_date')
    .eq('grant_id', grant.id)
    .eq('status', 'active');
  return { grant, bookings: data || [], crossMeetings, oneoffs };
}

// ── One-off "extra meeting" ledger (the separate, additive senior track) ─────
// Admin-issued: one extra meeting with a chosen teacher/length, bookable in a
// window, OUTSIDE the deterministic weekly cadence. See supabase/senior_oneoff_grants.sql.

// The student's active (un-spent, un-cancelled) one-off grants.
export async function loadSeniorOneoffs(studentSheetId) {
  const sb = getSupabaseClient();
  const { data } = await sb
    .from(SENIOR_ONEOFF_GRANTS)
    .select('id, teacher, minutes, valid_from, valid_through, status')
    .eq('student_sheet_id', studentSheetId)
    .eq('status', 'active');
  return data || [];
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
