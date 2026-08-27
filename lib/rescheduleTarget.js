// Verification for the client-supplied `excludeEventId` used by the reschedule flow.
//
// WHY THIS EXISTS. That id suppresses two safety checks at once: the double-booking
// conflict scan, and the student's own consumed allowance in the senior ledger. Taken
// on trust it is a "don't charge me" flag — a student could pass the id of a meeting
// they fully intend to KEEP, book a replacement, never cancel, and end up with more
// meetings than their grant funds (and, on the one-off track, repeat it indefinitely).
// So it is resolved against the real calendar event before any gate consults it.
//
// Ownership mirrors getUpcomingMeetings: portal provenance first
// (extendedProperties.private.studentEmail), then the title-match rule for meetings an
// instructor created by hand. Pass `studentName` only where it's known — omitting it
// simply disables the title fallback, which is the safe direction.
import { DateTime } from 'luxon';
import { belongsToStudent } from './calendarTitles';

const ZONE = 'America/Los_Angeles';

// Does this calendar event belong to this caller? Portal provenance first
// (extendedProperties.private.studentEmail, written by bookMeeting), then the
// title-match rule for meetings an instructor created by hand.
//
// `studentName` MUST be resolved server-side by the caller. Passing a
// client-supplied name here reopens the hole this guards: an attacker would simply
// send the victim's name and pass the title fallback. Omitting it disables the
// fallback, which is always the safe direction.
//
// Returns the event on success, null on unknown/inaccessible/cancelled/not-yours —
// callers decide whether that means "ignore" (reschedule) or "refuse" (cancel).
export async function fetchOwnedEvent(calendar, instructor, eventId, email, studentName) {
  if (!eventId) return null;
  let ev;
  try {
    const res = await calendar.events.get({
      calendarId: instructor.calendarId,
      eventId,
    });
    ev = res.data;
  } catch {
    return null;
  }
  if (!ev || ev.status === 'cancelled') return null;

  const owner = ev.extendedProperties?.private?.studentEmail;
  const mine = owner
    ? owner.toLowerCase() === String(email || '').toLowerCase()
    : !!(studentName
         && ev.summary?.toLowerCase().includes(String(studentName).toLowerCase().trim())
         && belongsToStudent({ summary: ev.summary }));
  return mine ? ev : null;
}

// Returns the verified event id, or null. Null means "ignore the exclusion", never
// "allow it anyway" — every caller must key its filters off the RETURN VALUE.
export async function resolveRescheduleTarget(
  calendar, instructor, excludeEventId, email, studentName, now, { requireNotice = true } = {}
) {
  // unknown / inaccessible / cancelled / not-yours → behave as if none was sent
  const ev = await fetchOwnedEvent(calendar, instructor, excludeEventId, email, studentName);
  if (!ev) return null;

  // The 24-hour reschedule notice, enforced BEFORE anything is created. It used to live
  // in cancelMeeting, which the old flow called first; now that the booking happens
  // first, checking it here is what keeps a late reschedule a clean no-op.
  const startsAt = DateTime.fromISO(ev.start?.dateTime || ev.start?.date).setZone(ZONE);
  if (!startsAt.isValid) return null;
  const cutoff = requireNotice ? (now || DateTime.now().setZone(ZONE)).plus({ hours: 24 }) : (now || DateTime.now().setZone(ZONE));
  if (startsAt < cutoff) return null;

  return ev.id;
}
