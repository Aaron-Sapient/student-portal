// Per-instructor booking configuration (server-only — contains calendar IDs).
// Public fields (slug, displayName, hoursByWeekday) live in lib/instructorPublic.js
// so client components can import them without pulling in this file.
// hoursByWeekday uses Luxon's 1-7 (Mon-Sun) keys; null = no meetings that day.
// Hours are inclusive of `start` and exclusive of `end` (so end:20 means last slot ends at 20:00).

import { INSTRUCTOR_PUBLIC } from './instructorPublic';

export const INSTRUCTORS = {
  ryan: {
    ...INSTRUCTOR_PUBLIC.ryan,
    calendarId: process.env.GOOGLE_CALENDAR_ID_RYAN,
    masterColumn: 'AZ',
    bookingEmail: 'support@admissions.partners',
    cancelEmail: 'ryan@admissions.partners',
    tokenIsTimestamp: false,
  },
  aaron: {
    ...INSTRUCTOR_PUBLIC.aaron,
    calendarId: process.env.GOOGLE_CALENDAR_ID_AARON,
    masterColumn: 'BB',
    bookingEmail: 'aaron@admissions.partners',
    cancelEmail: 'aaron@admissions.partners',
    tokenIsTimestamp: false,
  },
  // ART: same calendar/zoom as Aaron, but token tracked as ISO timestamp in BD
  // (allows implicit weekly reset by comparing against most-recent Saturday).
  art: {
    ...INSTRUCTOR_PUBLIC.art,
    calendarId: process.env.GOOGLE_CALENDAR_ID_AARON,
    masterColumn: 'BD',
    bookingEmail: 'aaron@admissions.partners',
    cancelEmail: 'aaron@admissions.partners',
    tokenIsTimestamp: true,
  },
};

export function getInstructor(slug) {
  const key = (slug || 'ryan').toLowerCase();
  return INSTRUCTORS[key] || INSTRUCTORS.ryan;
}

// Validate a Luxon DateTime against an instructor's hours.
// Returns null if valid, or an error string.
export function validateInstructorHours(instructor, startTime) {
  const hours = instructor.hoursByWeekday[startTime.weekday];
  if (!hours) {
    return `${instructor.displayName} does not take meetings on this day of the week.`;
  }
  if (startTime.hour < hours.start || startTime.hour >= hours.end) {
    const fmt = (h) => {
      const hr = h % 12 === 0 ? 12 : h % 12;
      const ampm = h < 12 ? 'am' : 'pm';
      return `${hr}${ampm}`;
    };
    return `Meetings with ${instructor.displayName} on this day must be ${fmt(hours.start)}–${fmt(hours.end)}.`;
  }
  return null;
}
