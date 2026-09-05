import { DateTime } from 'luxon';
import { getInstructor } from '@/lib/instructors';
import { getLead } from '@/app/next/[slug]/leads';
import { NEXT_DURATION_MINUTES } from '@/lib/nextBooking';
import { buildEventTitle } from '@/lib/calendarTitles';

/* GET /api/next/ics?slug=<slug>  ->  text/calendar

   "Add to Apple Calendar" on the booked panel, and in practice "add to
   anything that is not Google": Outlook, Fantastical, Thunderbird and iOS all
   open a .ics. Google gets a template URL built on the client instead, because
   Google's own importer wants a URL rather than a file.

   THIS EXISTS BECAUSE THE INVITATION DOES NOT. While Google was inviting the
   family, the meeting appeared in their calendar by itself and this route would
   have been redundant. Removing attendees (no domain-wide delegation, see
   /api/next/book) moved that work to the family, so the page has to hand them
   something they can actually add. One tap is close to what the invitation did;
   an email they have to retype is not.

   The times are written in UTC with a Z suffix, which every client reads
   correctly regardless of the zone it displays in. Writing local times would
   mean shipping a VTIMEZONE block, and getting that subtly wrong is how a
   meeting lands an hour out in exactly one calendar app. */

/* RFC 5545 line folding: octets, not characters, and a leading space marks the
   continuation. Long Zoom URLs in DESCRIPTION are what makes this necessary. */
function fold(line) {
  if (line.length <= 74) return line;
  const parts = [line.slice(0, 74)];
  let rest = line.slice(74);
  while (rest.length > 73) {
    parts.push(' ' + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  if (rest) parts.push(' ' + rest);
  return parts.join('\r\n');
}

/* Commas, semicolons and backslashes are separators inside a property value,
   and a raw newline ends the property. */
function esc(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const slug = searchParams.get('slug') || '';
  const lead = await getLead(slug);
  if (!lead || lead.status === 'closed') return new Response('Not found', { status: 404 });

  const booking = lead.booked;
  if (!booking?.start) return new Response('No booking', { status: 404 });

  const b = lead.booking || {};
  const instructor = getInstructor(b.instructor);
  const minutes = b.durationMinutes || NEXT_DURATION_MINUTES;
  const start = DateTime.fromISO(booking.start).toUTC();
  const end = start.plus({ minutes });
  const stamp = (d) => d.toFormat("yyyyLLdd'T'HHmmss'Z'");

  const title = buildEventTitle({
    studentName: b.calendarName || lead.student || 'Admissions Partners',
    duration: `${minutes}min`,
    agenda: b.agenda || 'Second conversation',
    prefix: lead.rehearsal ? 'REHEARSAL: ' : '',
  });

  /* UID is derived from the Google event id, so re-adding after a reschedule
     UPDATES the entry the family already has instead of leaving them holding
     two meetings. SEQUENCE rises with booked_at for the same reason. */
  const uid = `${booking.event_id || slug}@book.ryanchoice.com`;
  const sequence = booking.booked_at ? Math.floor(DateTime.fromISO(booking.booked_at).toSeconds()) % 100000 : 0;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Admissions Partners//Lead Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${esc(uid)}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${stamp(DateTime.utc())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    fold(`SUMMARY:${esc(title)}`),
    fold(`DESCRIPTION:${esc(`Zoom: ${instructor.zoomLink}`)}`),
    fold(`LOCATION:${esc(instructor.zoomLink)}`),
    fold(`URL:${esc(instructor.zoomLink)}`),
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  /* CRLF, which the spec requires and some parsers enforce. */
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="conversation-with-${instructor.slug}.ics"`,
      'Cache-Control': 'no-store',
    },
  });
}
