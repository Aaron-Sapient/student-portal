// Teaching guardrails — the rules that keep an instructor's DAY sane, on top of the
// per-weekday hours in lib/instructorPublic.js and the one-off dates in lib/blocks.js.
//
// Two rules, both configured per instructor in lib/instructorPublic.js:
//   unavailableByWeekday — standing windows that are never bookable (Aaron: Fri 4:00–4:30,
//     the breather before the fixed Friday lessons). A recurring gap, so NOT a blocks row
//     (blocks are literal date ranges, no weekday concept).
//   maxTeachingRunMinutes / teachingRunGapMinutes — a candidate slot is refused when the
//     continuous run of calendar events it would join (events separated by at most
//     `gap` minutes count as one run) would exceed the cap. Calendar events are the
//     input on purpose: Aaron's guaranteed weekly lessons (Olivia/Brandon/Doudou) are
//     Sapient-created events on his calendar, not portal bookings, so they count as
//     teaching even though the portal never booked them. Non-teaching events count too;
//     that errs toward protecting the day, which is the point.
//
// Applied at all three availability sites — getAvailableSlots, getMonthAvailability,
// bookMeeting (the final authority, since slot endpoints can be bypassed). Change one,
// change all three. (Added 2026-08-25 after Fri 08-28 filled 4:00–8:00 solid.)
import { DateTime } from 'luxon';

const ZONE = 'America/Los_Angeles';

function atMinutes(day, minutes) {
  return day.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });
}

// Standing unavailable windows for one LA calendar date → [{ start, end, reason }] (Luxon).
export function standingUnavailableWindows(instructor, dateStr) {
  const rules = instructor.unavailableByWeekday || {};
  const day = DateTime.fromISO(dateStr, { zone: ZONE });
  return (rules[day.weekday] || []).map(w => ({
    start: atMinutes(day, w.startMinute),
    end: atMinutes(day, w.endMinute),
    reason: w.reason || 'unavailable',
  }));
}

// Length in minutes of the continuous run that `candidate` ({start,end} Luxon) would form
// with `events` ([{start,end}] Luxon), linking windows whose gap is <= gapMinutes.
export function teachingRunMinutes(candidate, events, gapMinutes) {
  const windows = [...events, candidate]
    .map(w => ({ start: w.start, end: w.end }))
    .sort((a, b) => a.start - b.start);
  // Merge into runs.
  const runs = [];
  for (const w of windows) {
    const last = runs[runs.length - 1];
    if (last && w.start.diff(last.end, 'minutes').minutes <= gapMinutes) {
      if (w.end > last.end) last.end = w.end;
    } else {
      runs.push({ start: w.start, end: w.end });
    }
  }
  const mine = runs.find(r => candidate.start >= r.start && candidate.end <= r.end);
  return mine ? mine.end.diff(mine.start, 'minutes').minutes : candidate.end.diff(candidate.start, 'minutes').minutes;
}

// True when booking `candidate` would push the instructor past their cap. Instructors
// without a cap configured are never limited.
export function exceedsTeachingRun(instructor, candidate, events) {
  const cap = instructor.maxTeachingRunMinutes;
  if (!Number.isFinite(cap)) return false;
  const gap = Number.isFinite(instructor.teachingRunGapMinutes) ? instructor.teachingRunGapMinutes : 15;
  return teachingRunMinutes(candidate, events, gap) > cap;
}

export function overlapsAny(candidate, windows) {
  return windows.some(w => candidate.start < w.end && candidate.end > w.start);
}
