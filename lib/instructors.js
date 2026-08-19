// Per-instructor booking configuration (server-only — contains calendar IDs).
// Public fields (slug, displayName, hoursByWeekday) live in lib/instructorPublic.js
// so client components can import them without pulling in this file.
// hoursByWeekday uses Luxon's 1-7 (Mon-Sun) keys; null = no meetings that day.
// Hours are inclusive of `start` and exclusive of `end` (so end:20 means last slot ends at 20:00).

import { INSTRUCTOR_PUBLIC } from './instructorPublic.js';

export const INSTRUCTORS = {
  ryan: {
    ...INSTRUCTOR_PUBLIC.ryan,
    calendarId: process.env.GOOGLE_CALENDAR_ID_RYAN,
    bookingEmail: 'support@admissions.partners',
    cancelEmail: 'ryan@admissions.partners',
    tokenIsTimestamp: false,
  },
  aaron: {
    ...INSTRUCTOR_PUBLIC.aaron,
    calendarId: process.env.GOOGLE_CALENDAR_ID_AARON,
    bookingEmail: 'aaron@admissions.partners',
    cancelEmail: 'aaron@admissions.partners',
    tokenIsTimestamp: false,
  },
  // ART: same calendar/zoom as Aaron, but token tracked as an ISO timestamp
  // (allows implicit weekly reset by comparing against most-recent Saturday).
  art: {
    ...INSTRUCTOR_PUBLIC.art,
    calendarId: process.env.GOOGLE_CALENDAR_ID_AARON,
    bookingEmail: 'aaron@admissions.partners',
    cancelEmail: 'aaron@admissions.partners',
    tokenIsTimestamp: true,
  },
};

export function getInstructor(slug) {
  const key = (slug || 'ryan').toLowerCase();
  return INSTRUCTORS[key] || INSTRUCTORS.ryan;
}

const fmtHour = (h) => {
  const hr = h % 12 === 0 ? 12 : h % 12;
  const ampm = h < 12 ? 'am' : 'pm';
  return `${hr}${ampm}`;
};

// Validate a Luxon DateTime against an instructor's hours. Returns null if valid, or an
// error string. `mins` (optional) is the meeting's length — pass it and the meeting must
// also END by close, not merely start before it.
export function validateInstructorHours(instructor, startTime, mins) {
  const hours = instructor.hoursByWeekday[startTime.weekday];
  if (!hours) {
    return `${instructor.displayName} does not take meetings on this day of the week.`;
  }
  if (startTime.hour < hours.start || startTime.hour >= hours.end) {
    return `Meetings with ${instructor.displayName} on this day must be ${fmtHour(hours.start)}–${fmtHour(hours.end)}.`;
  }
  // A start-hour-only check silently permitted an overrun: 45 min from 6:30pm Friday
  // starts inside Ryan's 4–7pm window and ends at 7:15. The slot endpoints never OFFER
  // such a time (they require slotEnd <= close), so this only ever fires on a request
  // that bypassed them — and the span check in bookMeeting can't catch it, because a
  // crafted start/end pair matches its own duration exactly. Lengths that aren't a
  // divisor of the window (45, and 20 for the VIP packages) are what make it reachable.
  if (Number.isFinite(mins) && mins > 0) {
    const close = startTime.set({ hour: hours.end, minute: 0, second: 0, millisecond: 0 });
    if (startTime.plus({ minutes: mins }) > close) {
      return `A ${mins}-minute meeting with ${instructor.displayName} has to end by ${fmtHour(hours.end)} on this day.`;
    }
  }
  return null;
}
