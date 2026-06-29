// Supabase IO for the standing weekly "project meeting" track. SERVER-ONLY — imports
// the service-role client. The PURE rules (window, 1/week cap, card builder) live in
// lib/projectMeetingsCore.js so they're unit-testable from plain Node; this file adds
// the roster/ledger reads + writes and re-exports the core. See supabase/project_meetings.sql.

import { DateTime } from 'luxon';
import {
  getSupabaseClient,
  PROJECT_MEETING_PLANS,
  PROJECT_MEETING_BOOKINGS,
} from './supabase';
import { INSTRUCTORS } from './instructors';
import { ZONE, weekStartISO, startOfSaturdayWeek, buildProjectCards } from './projectMeetingsCore';

// Re-export the pure API so callers can import everything from '@/lib/projectMeetings'.
export * from './projectMeetingsCore';

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
    .eq('active', true);
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

// Move a project booking to a new date (admin reschedule): update meeting_date AND the
// week_start cap key. No-op for non-project events.
export async function rescheduleProjectBookingByEventId(eventId, newDt) {
  if (!eventId) return;
  const sb = getSupabaseClient();
  const day = newDt.setZone(ZONE);
  await sb
    .from(PROJECT_MEETING_BOOKINGS)
    .update({ meeting_date: day.toISODate(), week_start: startOfSaturdayWeek(day).toISODate() })
    .eq('calendar_event_id', eventId)
    .eq('status', 'active');
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
