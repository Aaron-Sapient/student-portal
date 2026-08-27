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
import { getStudentByEmail } from './identity';

const ZONE = 'America/Los_Angeles';

export const normEmail = (v) => String(v || '').trim().toLowerCase();

// The roster row for a signed-in email — the identity every booking route keys on.
// Replaces the Master `A:BD` read (col J = email, col G = portal URL, col BC = ART).
//
// ONE implementation, not two: this delegates to lib/identity.js getStudentByEmail
// rather than running its own query. The local copy used `.ilike` (whose `_` is a
// single-character WILDCARD, so `a_b@x.com` could match `axb@x.com`) and no status
// filter, so it resolved NC/inactive students the identity path deliberately
// excludes — two answers to "who is this email" that disagreed on exactly the rows
// that matter. Returns null on a clean miss; throws on a DB error (callers decide
// the failure mode). Callers read name / student_sheet_id / id / art_eligible, all
// of which are in identity's STUDENT_COLS.
export async function studentByEmail(email) {
  return getStudentByEmail(email);
}

// Active rows for one instructor's day that have NO calendar event yet ("calendar
// sync pending"). Calendar cannot see these — they exist only in Postgres until
// reconcile pushes them — so any check that reads Calendar alone (the booking
// conflict window, the teaching-run cap) must union them in or a booking recorded
// during a Calendar outage silently double-books its own slot.
// Keyed on calendar_id when the caller knows it (ART rides Aaron's calendar, so a
// pending ART row must conflict with a standard Aaron booking), with the instructor
// slug as the fallback for rows whose calendar_id was never stamped.
export async function pendingBookingsForInstructorDay({ instructor, calendarId, dateISO }) {
  if (!dateISO) return [];
  const slug = instructor === 'art' ? 'aaron' : instructor;
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from(BOOKINGS)
    .select('id, instructor, calendar_id, start_time, end_time, minutes, meeting_date')
    .eq('meeting_date', dateISO)
    .eq('status', 'active')
    .is('calendar_event_id', null);
  if (error) throw error;
  return (data || []).filter((r) => (
    (calendarId && r.calendar_id === calendarId) || r.instructor === slug
  ));
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
  // ONE comparable key, in ONE zone. `start` is a UTC ISO INSTANT
  // ('2026-08-28T00:30:00.000Z') and `meetingDate` is an LA CALENDAR DAY
  // ('2026-08-27') — string-comparing them mixed both format and zone, so an
  // evening LA standard meeting (which is the next day in UTC) sorted after a
  // project meeting on the following LA day. Everything is reduced to LA
  // 'YYYY-MM-DD HH:mm'; a day-only row sorts at the top of its day, which is where
  // the reader (getUpcomingMeetings) already places it.
  const sortKey = (r) => (r.start
    ? DateTime.fromISO(r.start).setZone(ZONE).toFormat('yyyy-LL-dd HH:mm')
    : `${r.meetingDate} 00:00`);
  rows.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return rows;
}

// Past meetings for home-data's sessions strip: [{ day, instructor }] over an LA
// window. ART rides Aaron's calendar → counts as aaron (same as before).
export async function pastBookingDays(studentSheetId, from, to) {
  const rows = await listStudentBookings(studentSheetId, { from, to });
  return rows.map((r) => ({ day: r.meetingDate, instructor: r.instructor === 'ryan' ? 'ryan' : 'aaron' }));
}
