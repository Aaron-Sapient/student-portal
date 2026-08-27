// Standard (Ryan/Aaron) + ART booking RECORD — Supabase `bookings` (supabase/bookings.sql).
//
// The other two tracks already keep their own ledgers (lib/projectMeetings.js →
// project_meeting_bookings, lib/seniors.js → senior_bookings). This module is the
// third, for the track that until 2026-08-27 had no Postgres record at all, plus the
// union readers every student-facing "meetings" surface should use instead of
// listing Calendar and fuzzy-matching titles (the defect F9 named).
//
// Contract with Calendar (the one accepted Google dependency): the ROW is written
// first, the event second, the id attached third. A row with calendar_event_id null
// is "calendar sync pending" — visible, enumerable, healed by scripts/reconcileBookings.cjs.
import { DateTime } from 'luxon';
import { getSupabaseClient, BOOKINGS, PROJECT_MEETING_BOOKINGS, SENIOR_BOOKINGS } from './supabase';

const ZONE = 'America/Los_Angeles';

export const normEmail = (v) => String(v || '').trim().toLowerCase();

// The roster row for a signed-in email — the identity every booking route keys on.
// Replaces the Master `A:BD` read (col J = email, col G = portal URL, col BC = ART).
// Returns null on a clean miss; throws on a DB error (callers decide the failure mode).
export async function studentByEmail(email) {
  const e = normEmail(email);
  if (!e) return null;
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from('students')
    .select('student_sheet_id, id, name, student_email, art_eligible, status')
    .ilike('student_email', e)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// INSERT the record. Called BEFORE calendar.events.insert. Returns the row.
export async function recordStandardBooking({
  studentSheetId, studentId, studentEmail, instructor, track, calendarId, start, end, minutes, agenda,
}) {
  const sb = getSupabaseClient();
  const startLA = DateTime.fromISO(start).setZone(ZONE);
  const { data, error } = await sb
    .from(BOOKINGS)
    .insert({
      student_sheet_id: studentSheetId,
      student_id: studentId || null,
      student_email: normEmail(studentEmail) || null,
      instructor,
      track: track || 'standard',
      calendar_id: calendarId || null,
      calendar_event_id: null,
      meeting_date: startLA.toISODate(),
      start_time: startLA.toUTC().toISO(),
      end_time: DateTime.fromISO(end).toUTC().toISO(),
      minutes,
      agenda: agenda || null,
      source: 'portal',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// Attach the event once Calendar has created it.
export async function attachCalendarEvent(bookingId, eventId) {
  const sb = getSupabaseClient();
  const { error } = await sb
    .from(BOOKINGS)
    .update({ calendar_event_id: eventId, updated_at: new Date().toISOString() })
    .eq('id', bookingId);
  if (error) throw error;
}

export async function standardBookingByEventId(eventId) {
  if (!eventId) return null;
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from(BOOKINGS)
    .select('*')
    .eq('calendar_event_id', eventId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Mark the record cancelled. Returns the row that WAS active (so the caller can
// restore the token to its original length), or null when no active row matched —
// a senior/project/hand-made event, which is safe to call unconditionally.
// Throws on a real DB error (supabase-js resolves { data:null, error } without
// throwing; swallowing it would report "not a standard booking" for one that is).
export async function cancelStandardBookingByEventId(eventId) {
  if (!eventId) return null;
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from(BOOKINGS)
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('calendar_event_id', eventId)
    .eq('status', 'active')
    .select('*');
  if (error) throw error;
  return (data || [])[0] || null;
}

// Undo a cancel when the Calendar delete failed for a reason other than "already
// gone" — keeps the row and the event agreeing.
export async function reactivateStandardBooking(bookingId) {
  const sb = getSupabaseClient();
  const { error } = await sb
    .from(BOOKINGS)
    .update({ status: 'active', cancelled_at: null, updated_at: new Date().toISOString() })
    .eq('id', bookingId);
  if (error) throw error;
}

// ── Union readers ──────────────────────────────────────────────────────────────
// One shape across the three ledgers:
//   { table, id, calendarEventId, instructor:'aaron'|'ryan', track:'standard'|'art'|'project'|'senior',
//     meetingDate:'YYYY-MM-DD', start:ISO|null, end:ISO|null, minutes, agenda|null, planId|null }
// `start`/`end` are null for project/senior rows — those ledgers store only the LA
// day (their event carries the time). Callers that need the clock time fetch the
// event BY ID (never by title) and degrade to the day when Calendar is unavailable.
export async function listStudentBookings(studentSheetId, { from, to } = {}) {
  if (!studentSheetId) return [];
  const sb = getSupabaseClient();
  const fromISO = from ? DateTime.fromISO(String(from), { zone: ZONE }).toISODate() : null;
  const toISO = to ? DateTime.fromISO(String(to), { zone: ZONE }).toISODate() : null;
  const bound = (q) => {
    if (fromISO) q = q.gte('meeting_date', fromISO);
    if (toISO) q = q.lte('meeting_date', toISO);
    return q;
  };

  const [std, proj, sen] = await Promise.all([
    bound(sb.from(BOOKINGS)
      .select('id, calendar_event_id, instructor, track, meeting_date, start_time, end_time, minutes, agenda')
      .eq('student_sheet_id', studentSheetId).eq('status', 'active')),
    bound(sb.from(PROJECT_MEETING_BOOKINGS)
      .select('id, calendar_event_id, plan_id, teacher, meeting_date, minutes')
      .eq('student_sheet_id', studentSheetId).eq('status', 'active')),
    bound(sb.from(SENIOR_BOOKINGS)
      .select('id, calendar_event_id, teacher, meeting_date, minutes')
      .eq('student_sheet_id', studentSheetId).eq('status', 'active')),
  ]);
  for (const r of [std, proj, sen]) if (r.error) throw r.error;

  const rows = [
    ...(std.data || []).map((r) => ({
      table: BOOKINGS, id: r.id, calendarEventId: r.calendar_event_id,
      instructor: r.instructor, track: r.track,
      meetingDate: r.meeting_date, start: r.start_time, end: r.end_time,
      minutes: r.minutes, agenda: r.agenda, planId: null,
    })),
    ...(proj.data || []).map((r) => ({
      table: PROJECT_MEETING_BOOKINGS, id: r.id, calendarEventId: r.calendar_event_id,
      instructor: r.teacher, track: 'project',
      meetingDate: r.meeting_date, start: null, end: null,
      minutes: r.minutes, agenda: null, planId: r.plan_id,
    })),
    ...(sen.data || []).map((r) => ({
      table: SENIOR_BOOKINGS, id: r.id, calendarEventId: r.calendar_event_id,
      instructor: r.teacher, track: 'senior',
      meetingDate: r.meeting_date, start: null, end: null,
      minutes: r.minutes, agenda: null, planId: null,
    })),
  ];
  rows.sort((a, b) => (a.start || a.meetingDate).localeCompare(b.start || b.meetingDate));
  return rows;
}

// Past meetings for home-data's sessions strip: [{ day, instructor }] over an LA
// window. ART rides Aaron's calendar → counts as aaron (same as before).
export async function pastBookingDays(studentSheetId, from, to) {
  const rows = await listStudentBookings(studentSheetId, { from, to });
  return rows.map((r) => ({ day: r.meetingDate, instructor: r.instructor === 'ryan' ? 'ryan' : 'aaron' }));
}
