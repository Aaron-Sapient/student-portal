// Supabase IO for the standing weekly "project meeting" track. SERVER-ONLY — imports
// the service-role client. The PURE rules (window, 1/week cap, card builder) live in
// lib/projectMeetingsCore.js so they're unit-testable from plain Node; this file adds
// the roster/ledger reads + writes and re-exports the core. See supabase/project_meetings.sql.

import { DateTime } from 'luxon';
import {
  getSupabaseClient,
  PROJECT_MEETING_PLANS,
  PROJECT_MEETING_BOOKINGS,
} from './supabase.js';
import { INSTRUCTORS } from './instructors.js';
import { ZONE, weekStartISO, startOfSaturdayWeek, buildProjectCards } from './projectMeetingsCore.js';
import { sameSession } from './sessionSpec.js';

// Re-export the pure API so callers can import everything from '@/lib/projectMeetings'.
export * from './projectMeetingsCore.js';

// ── Plan lookups ─────────────────────────────────────────────────────────────

// A student's active project-meeting plans (by Master/portal sheet id). Used by
// home-data to build the cards.
export async function loadProjectPlans(studentSheetId) {
  if (!studentSheetId) return [];
  const sb = getSupabaseClient();
  const { data } = await sb
    .from(PROJECT_MEETING_PLANS)
    .select('id, student_sheet_id, student_email, teacher, minutes, label, active')
    .eq('student_sheet_id', studentSheetId)
    .eq('active', true)
    // Ordered, because the cards are a LIST the student learns by position: a student
    // can hold several plans (Olivia Lim holds three), and Postgres has no obligation
    // to return them the same way twice — unordered, her sessions would silently
    // reshuffle between loads, and meetings/page.js derives its animation delays from
    // the same array. Oldest first = the order they were set up in.
    .order('created_at');
  return data || [];
}

// The plan a booking request names (?m=project:<id>), but ONLY if it's active AND owned
// by the authenticated email — the booking-gate ownership check (a student can't spend
// another student's plan id). Returns the plan row or null.
export async function loadProjectPlanForBooking(email, planId) {
  if (!email || !planId) return null;
  const sb = getSupabaseClient();
  const { data } = await sb
    .from(PROJECT_MEETING_PLANS)
    .select('id, student_sheet_id, student_email, teacher, minutes, label, active')
    .eq('id', planId)
    .eq('active', true)
    .maybeSingle();
  if (!data) return null;
  const owns = String(data.student_email || '').trim().toLowerCase() === String(email).trim().toLowerCase();
  return owns ? data : null;
}

// A single plan by id (admin/inspection — no ownership filter).
export async function loadProjectPlanById(planId) {
  if (!planId) return null;
  const sb = getSupabaseClient();
  const { data } = await sb
    .from(PROJECT_MEETING_PLANS)
    .select('*')
    .eq('id', planId)
    .maybeSingle();
  return data || null;
}

// ── Booking ledger ───────────────────────────────────────────────────────────

// A plan's ACTIVE bookings from this Saturday-week forward — everything the horizon
// (this + next week) can contain, so the pure 1/week cap has what it needs.
export async function loadProjectBookingsForPlan(planId, now) {
  if (!planId) return [];
  const sb = getSupabaseClient();
  const fromWeek = weekStartISO((now || DateTime.now()).setZone(ZONE));
  const { data } = await sb
    .from(PROJECT_MEETING_BOOKINGS)
    .select('id, week_start, meeting_date, status')
    .eq('plan_id', planId)
    .eq('status', 'active')
    .gte('week_start', fromWeek);
  return data || [];
}

// Record a project booking against its plan (called after the calendar event is created).
// `dt` = the meeting DateTime.
export async function recordProjectBooking(plan, { eventId, dt, minutes, studentSheetId }) {
  const sb = getSupabaseClient();
  const day = dt.setZone(ZONE);
  const { error } = await sb.from(PROJECT_MEETING_BOOKINGS).insert({
    plan_id: plan.id,
    student_sheet_id: studentSheetId || plan.student_sheet_id,
    calendar_event_id: eventId,
    teacher: plan.teacher,
    meeting_date: day.toISODate(),
    week_start: startOfSaturdayWeek(day).toISODate(),
    minutes,
  });
  if (error) throw error;
}

// Free a project booking on cancel: mark the row cancelled so its week reopens. Returns
// true iff this event WAS a project booking — the cancel routes use that to skip the
// standard Master-token restore (a project meeting has no Master token; restoring one
// would mis-grant a regular meeting). No-op (returns false) for non-project events, so
// it's safe to call unconditionally on any cancel.
export async function cancelProjectBookingByEventId(eventId) {
  if (!eventId) return false;
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from(PROJECT_MEETING_BOOKINGS)
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('calendar_event_id', eventId)
    .eq('status', 'active')
    .select('id');
  // THROW on a real DB error rather than swallow it: supabase-js resolves to
  // { data: null, error } WITHOUT throwing, so returning (data||[]).length on error
  // would report wasProject=false for what IS a project booking — and the cancel route
  // would then restore a standard Master token (mis-granting a free regular meeting).
  // A surfaced error 500s the cancel instead, which is the correct, safe signal.
  if (error) throw error;
  return (data || []).length > 0;
}

// Would moving this event to `newDt` collide with the plan's 1/week cap? Returns null when
// the event isn't a project booking or the move is fine, else a human-readable reason.
// The admin reschedule route calls this BEFORE patching the calendar: the ledger update
// below would otherwise hit pmb_one_active_per_week AFTER the event moved, leaving the
// calendar and the ledger disagreeing (the exact desync this pair exists to prevent).
export async function projectRescheduleConflict(eventId, newDt) {
  if (!eventId) return null;
  const sb = getSupabaseClient();
  const { data: row } = await sb
    .from(PROJECT_MEETING_BOOKINGS)
    .select('id, plan_id')
    .eq('calendar_event_id', eventId)
    .eq('status', 'active')
    .maybeSingle();
  if (!row) return null;
  const wk = startOfSaturdayWeek(newDt.setZone(ZONE)).toISODate();
  const { data: clash } = await sb
    .from(PROJECT_MEETING_BOOKINGS)
    .select('id, meeting_date')
    .eq('plan_id', row.plan_id)
    .eq('week_start', wk)
    .eq('status', 'active')
    .neq('id', row.id)
    .maybeSingle();
  if (!clash) return null;
  return `That week already has this weekly session booked (${clash.meeting_date}) — one per week per session. Pick a date in a different week, or cancel the other one first.`;
}

// Move a project booking to a new date (admin reschedule): update meeting_date AND the
// week_start cap key. No-op for non-project events.
export async function rescheduleProjectBookingByEventId(eventId, newDt) {
  if (!eventId) return;
  const sb = getSupabaseClient();
  const day = newDt.setZone(ZONE);
  const { error } = await sb
    .from(PROJECT_MEETING_BOOKINGS)
    .update({ meeting_date: day.toISODate(), week_start: startOfSaturdayWeek(day).toISODate() })
    .eq('calendar_event_id', eventId)
    .eq('status', 'active');
  // Surface, don't swallow (same reasoning as cancelProjectBookingByEventId): the one
  // realistic failure is the 1/week unique index — the admin moved a session into a
  // week that already holds one for that plan. A silent swallow would leave the calendar
  // moved and the ledger stale, which is the exact desync this call exists to prevent;
  // a thrown error 500s the admin panel with the reason instead.
  if (error) throw error;
}

// ── Plan creation (admin) ────────────────────────────────────────────────────

export async function createProjectPlan({ studentSheetId, studentEmail, teacher, minutes, label, note, grantedBy }) {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from(PROJECT_MEETING_PLANS)
    .insert({
      student_sheet_id: studentSheetId,
      student_email: studentEmail || null,
      teacher,
      minutes,
      label,
      note: note || null,
      granted_by: grantedBy || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// The student's ACTIVE plan that is "the same session" as `spec` ({ teacher, minutes,
// label }), or null. The admin route and scripts/sessions.mjs both refuse to add a second
// one by default: the 1/week cap is per plan, so an identical duplicate silently doubles
// the weekly meetings (2026-08-06 health note, §1d). Identity = sessionSpec.sameSession.
export async function findActiveDuplicatePlan(studentSheetId, spec) {
  const plans = await loadProjectPlans(studentSheetId);
  return plans.find((p) => sameSession(p, spec)) || null;
}

// End a plan: active=false + a dated line appended to `note`. The row stays (its bookings
// reference it, and "what did this student used to have" is a real question), the card
// disappears on the student's next load, and already-booked meetings are untouched —
// they live on the calendar + the bookings ledger, which cancel/reschedule still find by
// event id. Returns the updated row.
export async function endProjectPlan(planId, { reason, endedBy } = {}) {
  const sb = getSupabaseClient();
  const { data: cur } = await sb.from(PROJECT_MEETING_PLANS).select('note').eq('id', planId).maybeSingle();
  const stamp = DateTime.now().setZone(ZONE).toISODate(); // LA, like every business date here
  const line = `ended ${stamp}${endedBy ? ` by ${endedBy}` : ''}${reason ? `: ${reason}` : ''}`;
  const note = cur?.note ? `${cur.note} | ${line}` : line;
  const { data, error } = await sb
    .from(PROJECT_MEETING_PLANS)
    .update({ active: false, note })
    .eq('id', planId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Client-ready cards (home-data) ───────────────────────────────────────────
// Load a student's active plans + their active bookings, build the cards, and decorate
// with the instructor display name. This is what the meetings page renders.
export async function projectMeetingCards(studentSheetId, now) {
  const plans = await loadProjectPlans(studentSheetId);
  if (plans.length === 0) return [];
  const n = (now || DateTime.now()).setZone(ZONE);
  const fromWeek = weekStartISO(n);
  const sb = getSupabaseClient();
  const { data: bookingRows } = await sb
    .from(PROJECT_MEETING_BOOKINGS)
    .select('plan_id, week_start, meeting_date, status')
    .eq('student_sheet_id', studentSheetId)
    .eq('status', 'active')
    .gte('week_start', fromWeek);
  const byPlan = {};
  for (const b of bookingRows || []) (byPlan[b.plan_id] ??= []).push(b);

  const name = (slug) => INSTRUCTORS[slug]?.displayName || slug;
  return buildProjectCards(plans, byPlan, n).map((c) => ({ ...c, name: name(c.slug) }));
}
