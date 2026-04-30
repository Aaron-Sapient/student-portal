// Client-safe instructor metadata. NO secrets — calendar IDs and emails live in lib/instructors.js
// (server-only). This file can be imported from client components.

const AARON_HOURS = {
  1: { start: 12, end: 20 },
  2: { start: 12, end: 20 },
  3: { start: 12, end: 20 },
  4: { start: 12, end: 20 },
  5: { start: 12, end: 20 },
  6: null,
  7: null,
};

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
  },
  // Advanced Research Team — books on Aaron's calendar with same hours/zoom,
  // but uses a different master-sheet column (BD) and a timestamp-based token.
  art: {
    slug: 'art',
    displayName: 'ART',
    bodyName: 'Aaron',
    zoomLink: 'https://us02web.zoom.us/j/3200479217',
    hoursByWeekday: AARON_HOURS,
  },
};

export function getInstructorPublic(slug) {
  return INSTRUCTOR_PUBLIC[(slug || 'ryan').toLowerCase()] || INSTRUCTOR_PUBLIC.ryan;
}
