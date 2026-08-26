// Client-safe instructor metadata. NO secrets — calendar IDs and emails live in lib/instructors.js
// (server-only). This file can be imported from client components.

// Tue/Thu start at 15 (3pm), not 12: Aaron's 12–2pm is permanently unavailable on those
// days (2026-08-16). This is the standing schedule, deliberately NOT a lib/blocks.js entry —
// blocks are for one-off dates. Because the window sits at the START of the day, moving
// `start` is the whole change; a mid-day recurring gap would need a different shape.
const AARON_HOURS = {
  1: { start: 12, end: 20 },
  2: { start: 15, end: 20 },
  3: { start: 12, end: 20 },
  4: { start: 15, end: 20 },
  5: { start: 12, end: 20 },
  6: null,
  7: null,
};

// Standing gaps and day-shape guardrails for Aaron (2026-08-25). Read by
// lib/teachingGuardrails.js at all three availability sites. Minutes from LA midnight.
// Fri 4:00–4:30 is the breather before the fixed Friday lessons (Sapient calendar
// events, not portal bookings; which ones is in lib/teachingGuardrails.js, server-only —
// this file ships to the client).
const AARON_UNAVAILABLE = {
  5: [{ startMinute: 16 * 60, endMinute: 16 * 60 + 30, reason: 'Friday breather' }],
};
// No continuous teaching run longer than 3.5h; events <= 15 min apart count as one run.
const AARON_MAX_RUN_MINUTES = 210;
const AARON_RUN_GAP_MINUTES = 15;

// `slug` is the URL/routing identifier (used in `?instructor=...` and master-sheet config lookups).
// `displayName` is the program label used in calendar event titles and emails.
// `bodyName` is the human shown to students in body text — for ART, that's "Aaron"
// because students are meeting with Aaron, not with a program. Decoupling these prevents bugs
// where renaming the URL slug would cascade into student-facing copy.
export const INSTRUCTOR_PUBLIC = {
  ryan: {
    slug: 'ryan',
    displayName: 'Ryan',
    bodyName: 'Ryan',
    zoomLink: 'https://us02web.zoom.us/j/8846768033',
    hoursByWeekday: {
      1: null,
      2: { start: 16, end: 20 },
      3: { start: 16, end: 20 },
      4: { start: 16, end: 20 },
      5: { start: 16, end: 19 },
      6: null,
      7: null,
    },
  },
  aaron: {
    slug: 'aaron',
    displayName: 'Aaron',
    bodyName: 'Aaron',
    zoomLink: 'https://us02web.zoom.us/j/3200479217',
    hoursByWeekday: AARON_HOURS,
    unavailableByWeekday: AARON_UNAVAILABLE,
    maxTeachingRunMinutes: AARON_MAX_RUN_MINUTES,
    teachingRunGapMinutes: AARON_RUN_GAP_MINUTES,
  },
  // Advanced Research Team — books on Aaron's calendar with same hours/zoom,
  // but uses a different master-sheet column (BD) and a timestamp-based token.
  art: {
    slug: 'art',
    displayName: 'ART',
    bodyName: 'Aaron',
    zoomLink: 'https://us02web.zoom.us/j/3200479217',
    hoursByWeekday: AARON_HOURS,
    unavailableByWeekday: AARON_UNAVAILABLE,
    maxTeachingRunMinutes: AARON_MAX_RUN_MINUTES,
    teachingRunGapMinutes: AARON_RUN_GAP_MINUTES,
  },
};

export function getInstructorPublic(slug) {
  return INSTRUCTOR_PUBLIC[(slug || 'ryan').toLowerCase()] || INSTRUCTOR_PUBLIC.ryan;
}
