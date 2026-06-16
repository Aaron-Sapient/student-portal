import { DateTime } from 'luxon';

export const ZONE = 'America/Los_Angeles';

// Google Sheets hands us either a serial number (days since 1899-12-30) or a
// string. Pin both to the LA *calendar date* so display never drifts a day.
export function parseSheetDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    const utc = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000), { zone: 'utc' });
    if (!utc.isValid) return null;
    return DateTime.fromObject({ year: utc.year, month: utc.month, day: utc.day }, { zone: ZONE });
  }
  let dt = DateTime.fromISO(String(raw), { zone: ZONE });
  if (!dt.isValid) dt = DateTime.fromJSDate(new Date(raw)).setZone(ZONE);
  return dt.isValid ? dt : null;
}

export function startOfThisWeek() {
  const now = DateTime.now().setZone(ZONE);
  let sat = now.set({ weekday: 6 });
  if (now.weekday < 6) sat = sat.minus({ weeks: 1 });
  return sat.startOf('day');
}

export function checkedInThisWeek(raw) {
  const dt = parseSheetDate(raw);
  return !!dt && dt >= startOfThisWeek();
}

export function daysUntil(dt) {
  const now = DateTime.now().setZone(ZONE).startOf('day');
  return Math.round(dt.startOf('day').diff(now, 'days').days);
}

export function relativeLabel(days) {
  if (days < 0) return 'past due';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 7) return `in ${days} days`;
  return `in ${Math.round(days / 7)} wk${days >= 14 ? 's' : ''}`;
}

export function bookingHref(instructor, type) {
  const t = type === '30min' || type === '15min';
  return t ? `/meetings/${instructor}` : null;
}

// True when the student has any meeting they're currently entitled to book.
export function hasBookingAvailable(data) {
  if (!data) return false;
  return (
    !!bookingHref('ryan', data.meetingType) ||
    !!bookingHref('aaron', data.aaronMeetingType) ||
    (!!data.isART && !!data.artTokenAvailable)
  );
}

// True when either weekly check-in is still outstanding this week.
export function hasCheckinDue(data) {
  if (!data) return false;
  return !checkedInThisWeek(data.lastCheckin) || !checkedInThisWeek(data.aaronLastCheckin);
}
