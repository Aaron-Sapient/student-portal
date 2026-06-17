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
// The PURE rules (package math, week-of-month, canBook, …) live in
// lib/seniorsCore.js so they're unit-testable from plain Node; this file adds the
// Supabase roster lookups + Google-Calendar counting, and re-exports the core.

import { DateTime } from 'luxon';
import { getSupabaseClient, SENIORS_TABLE } from './supabase';
import { INSTRUCTORS } from './instructors';
import {
  ZONE,
  startOfSaturdayWeek,
  assignedPlanForWeek,
  bookableDurations,
  bookedForWeekOf,
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

// Display/decision summary for the week containing `dt` (needs instructor names).
export function weekSummary(senior, dt, booked) {
  const plan = assignedPlanForWeek(senior, dt);
  const primary = plan.primarySlug;
  const secondary = plan.secondarySlug;
  const get = (s) => ({ count: booked?.[s]?.count || 0, minutes: booked?.[s]?.minutes || 0 });
  const s = get(secondary);
  return {
    isPhaseWeek: plan.isPhaseWeek,
    primarySlug: primary,
    secondarySlug: secondary,
    primaryName: INSTRUCTORS[primary].displayName,
    secondaryName: INSTRUCTORS[secondary].displayName,
    // the cross-meeting is still owed and must be booked before primary unlocks
    secondaryRequired: plan.isPhaseWeek && s.count < 1,
    bookable: {
      [primary]: bookableDurations(senior, dt, primary, booked),
      [secondary]: bookableDurations(senior, dt, secondary, booked),
    },
    booked: { [primary]: get(primary), [secondary]: s },
  };
}
