import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { DEVELOPER_EMAIL } from '@/lib/developerAuth';
import { belongsToStudent } from '@/lib/calendarTitles';
import { getInstructor } from '@/lib/instructors';
import { getSupabaseClient } from '@/lib/supabase';
import { studentByEmail, listStudentBookings } from '@/lib/bookings';

const RYANS_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID_RYAN;
const AARONS_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID_AARON;
const ZONE = 'America/Los_Angeles';

// Calendar-only, read-only. The Sheets scope, the Master `A:AY`/`A:J` reads and the
// per-student `🔎 Overview!B2` read left this route on 2026-08-27 (zero-Google sweep,
// Package C). The student branch reads the three Postgres ledgers (lib/bookings.js);
// Calendar is consulted only BY EVENT ID, for the clock time the two older ledgers
// don't store, and the response degrades to the day when it is unavailable.
function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
}

// Parses event titles built by bookMeeting:
//   "{ART: }{studentName} – {duration}{: agenda}"
// Returns { studentName, duration } or {} if it doesn't match.
function parseTitle(title) {
  if (!title) return {};
  const stripped = title.replace(/^ART:\s*/, '');
  const m = stripped.match(/^(.+?)\s+[–-]\s+(\d+min|email)/);
  if (!m) return {};
  return { studentName: m[1].trim(), duration: m[2] };
}

// Same title/description the booking flow writes on the event, rebuilt from the
// record for rows that carry their own agenda (the `bookings` ledger).
function titleFor(row, studentName) {
  const prefix = row.track === 'art' ? 'ART: ' : '';
  const base = `${prefix}${studentName} – ${row.minutes}min`;
  return row.agenda ? `${base}: ${row.agenda}` : base;
}
function descriptionFor(row) {
  const zoom = getInstructor(row.track === 'art' ? 'art' : row.instructor).zoomLink;
  return row.agenda ? `Zoom: ${zoom}\nAgenda: ${row.agenda}` : `Zoom: ${zoom}`;
}
function displayInstructor(row) {
  if (row.track === 'art') return 'ART';
  return row.instructor === 'ryan' ? 'Ryan' : 'Aaron';
}

export async function GET(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const all = searchParams.get('all') === 'true';
  if (all && email !== DEVELOPER_EMAIL) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    // Admin "all meetings" branch: return events on either calendar whose title
    // contains a known student name. Deliberately still Calendar-driven — the dev
    // panel is where hand-made events (no ledger row) need to be visible. The
    // directory is Supabase `students` (name + login email) so an admin's freeform
    // title like "Aaron-Christine Oh" still resolves to a full name and email.
    if (all) {
      const now = new Date();
      const eightWeeksOut = new Date(now.getTime() + 8 * 7 * 24 * 60 * 60 * 1000);

      async function fetchAll(calendarId, instructorName) {
        const res = await calendar.events.list({
          calendarId,
          timeMin: now.toISOString(),
          timeMax: eightWeeksOut.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
        });
        return (res.data.items || [])
          .filter(e => e.status !== 'cancelled' && e.summary)
          .map(e => {
            const isArt = e.extendedProperties?.private?.bookingType === 'art'
              || e.summary?.startsWith('ART:');
            const fromExt = e.extendedProperties?.private || {};
            const parsed = parseTitle(e.summary);
            const slug = isArt ? 'art' : (fromExt.instructor || instructorName.toLowerCase());
            return {
              id: e.id,
              title: e.summary,
              start: e.start.dateTime || e.start.date,
              end: e.end.dateTime || e.end.date,
              description: e.description || '',
              instructor: isArt ? 'ART' : instructorName,
              instructorSlug: slug,
              studentEmail: fromExt.studentEmail || null,
              studentName: parsed.studentName || null,
              duration: fromExt.type || parsed.duration || null,
              fromPortal: fromExt.source === 'student-portal',
            };
          });
      }

      // Returns [{ name, normalized, email }, ...] sorted longest-name-first
      // so longer matches win during title scanning (e.g. "Anna Lee" beats "Anna").
      async function fetchStudentDirectory() {
        const sb = getSupabaseClient();
        const { data, error } = await sb.from('students').select('name, student_email');
        if (error) throw error;
        const dir = [];
        for (const r of data || []) {
          const name = String(r.name || '').trim();
          const mail = String(r.student_email || '').trim();
          if (!name) continue;
          dir.push({ name, normalized: name.toLowerCase(), email: mail || null });
        }
        dir.sort((a, b) => b.normalized.length - a.normalized.length);
        return dir;
      }

      const [ryans, aarons, directory] = await Promise.all([
        fetchAll(RYANS_CALENDAR_ID, 'Ryan'),
        fetchAll(AARONS_CALENDAR_ID, 'Aaron'),
        fetchStudentDirectory(),
      ]);

      const allMeetings = [...ryans, ...aarons]
        .map(m => {
          const titleLower = (m.title || '').toLowerCase();
          // Longest-first scan: first hit is the best (most specific) match.
          const hit = directory.find(s => titleLower.includes(s.normalized));
          if (!hit) return null; // not a student meeting — drop it
          // A parent meeting carries the student's name; attributing it to them
          // here would report it as one of that student's own sessions.
          if (!belongsToStudent({ summary: m.title })) return null;
          return {
            ...m,
            studentName: hit.name,
            studentEmail: m.studentEmail || hit.email,
          };
        })
        .filter(Boolean)
        .sort((a, b) => new Date(a.start) - new Date(b.start));

      return Response.json({ meetings: allMeetings });
    }

    // ── Student branch: the three Postgres ledgers, unioned ─────────────────
    const roster = await studentByEmail(email);
    if (!roster) return Response.json({ error: 'Student not found' }, { status: 404 });
    const studentName = String(roster.name || '').trim();

    const nowLA = DateTime.now().setZone(ZONE);
    const rows = await listStudentBookings(roster.student_sheet_id, {
      from: nowLA.toISODate(),
      to: nowLA.plus({ weeks: 8 }).toISODate(),
    });

    // Rows from the older ledgers (senior/project) store only the LA day; their event
    // carries the time. Fetch those events BY ID (never by title). A miss — Calendar
    // down, or the event hand-deleted before reconcile ran — degrades to the day
    // (start = 00:00 LA, `timeUnknown: true`) rather than dropping the meeting.
    const needsEvent = rows.filter((r) => !r.start && r.calendarEventId);
    const eventById = new Map();
    await Promise.all(needsEvent.map(async (r) => {
      const calendarId = getInstructor(r.instructor).calendarId;
      try {
        const res = await calendar.events.get({ calendarId, eventId: r.calendarEventId });
        if (res.data && res.data.status !== 'cancelled') eventById.set(r.calendarEventId, res.data);
      } catch (e) {
        console.warn(`getUpcomingMeetings: event ${r.calendarEventId} unavailable (${e?.code || e?.message}); degrading to the day`);
      }
    }));

    const meetings = rows
      .map((r) => {
        const ev = r.calendarEventId ? eventById.get(r.calendarEventId) : null;
        let start = r.start;
        let end = r.end;
        let timeUnknown = false;
        if (!start) {
          if (ev) {
            start = ev.start?.dateTime || ev.start?.date;
            end = ev.end?.dateTime || ev.end?.date;
          } else {
            const day = DateTime.fromISO(r.meetingDate, { zone: ZONE }).startOf('day');
            start = day.toISO();
            end = day.plus({ minutes: r.minutes || 0 }).toISO();
            timeUnknown = true;
          }
        }
        // Past-today rows in the older ledgers (meeting earlier today) stay out, as
        // the old Calendar window (timeMin = now) kept them out.
        if (DateTime.fromISO(end) < nowLA && !timeUnknown) return null;
        const bookingType = r.track === 'standard' ? 'standard' : r.track; // 'art' | 'project' | 'senior'
        return {
          // `id` is the CALENDAR EVENT id — the reschedule/cancel UI posts it back as
          // eventId/excludeEventId. Null while a booking's calendar sync is pending.
          id: r.calendarEventId,
          bookingId: r.table === 'bookings' ? r.id : null,
          title: ev?.summary || titleFor(r, studentName),
          start,
          end,
          description: ev?.description || descriptionFor(r),
          instructor: displayInstructor(r),
          // Surfaced so the reschedule UI can route project meetings to cancel+rebook
          // (a bare rebook drops ?m=project:<id> and mis-charges the essay grant).
          bookingType,
          calendarSyncPending: !r.calendarEventId,
          ...(timeUnknown ? { timeUnknown: true } : {}),
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    return Response.json({ meetings, studentName });

  } catch (err) {
    console.error('getUpcomingMeetings error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
