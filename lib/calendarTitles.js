// Attribution rules for calendar events matched to a student BY TITLE.
//
// Instructors title a meeting with the parents using the student's name —
// "Ryan-Olivia Lim Parents" — so a plain `summary.includes(studentName)` claims it
// as the student's own meeting. That is wrong everywhere it happens, and in one
// place it is a booking defect rather than a display one: lib/seniors.js counts
// title-matched events to enforce the weekly meeting cap, so a parent meeting
// silently consumes a meeting the student never received.
//
// Word-bounded on purpose (`\bparents?\b`): a bare substring test would also strike
// "apparent" and "transparent". Covers singular and plural, and any separator —
// "Parent-Teacher", "Parents/Guardians", "RE: parents" all match.
const PARENT_TITLE = /\bparents?\b/i;

export function isParentMeetingTitle(summary) {
  return PARENT_TITLE.test(String(summary || ''));
}

// THE rule every student-facing surface should apply. `authoritative` means the
// event carries extendedProperties.private.studentEmail matching this student —
// provenance from the portal's own booking flow, which beats any title heuristic.
//
// The exemption is load-bearing, not politeness. Portal bookings are titled
// "{name} – {duration}: {agenda}" where agenda is 30 chars the STUDENT typed, so a
// student who books with the agenda "parent questions" would otherwise watch their
// own real meeting vanish from the portal — and, on the seniors path, drop out of
// the cap count and let them book a second meeting that week. When the title
// heuristic errs there, it errs toward fail-OPEN on a booking gate; provenance
// closes that.
export function belongsToStudent({ summary, authoritative = false }) {
  if (authoritative) return true;
  return !isParentMeetingTitle(summary);
}
