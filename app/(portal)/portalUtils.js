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

// Bookable cards on the standing weekly project-meeting track (solo research, SAT
// sessions, …). ADDITIVE to every other track and read by BOTH branches below: this
// entitlement is granted directly (project_meeting_plans), so a student can hold one
// with no check-in token, no ART flag, and no senior grant whatsoever. `bookable`
// comes from buildProjectCard — it already accounts for the horizon and the 1/week cap.
export function hasBookableProject(data) {
  return (data?.projectMeetings || []).some((p) => p.bookable);
}

// True when the roster says this student is OUT of the weekly check-in cadence —
// master col BE "Needs Checkin", surfaced by home-data as `needsCheckin`. This is a
// human-maintained fact, not an inference, and two other consumers already gate on
// the same column with the same rule — excluded only on an EXPLICIT false, so a
// blank cell means "in the cadence": checkin-reminder/checkinReminder.gs and
// app/api/developer/checkinCompliance. The portal reading it is what stops the dock
// nudge from contradicting the reminder email.
//
// Reading the flag beats inferring from a null check-in timestamp on three counts:
// "has never checked in" is also exactly what a brand-new cadence student looks
// like; most students marked out DO have old timestamps, so the inference misses
// them; and submitting a single check-in would flip the inference permanently,
// making it a one-way trapdoor. The flag is stable under anything a student can do.
export function skipsCheckins(data) {
  return data?.needsCheckin === false;
}

// True when the student has any meeting they're currently entitled to book.
export function hasBookingAvailable(data) {
  if (!data) return false;
  // Checked before the senior branch: the project track is additive to the essay
  // cadence, so a senior with a bookable project card qualifies even at remaining 0.
  if (hasBookableProject(data)) return true;
  // Seniors: tokens left on their active check-in grant (remaining > 0 already
  // implies a grant exists; a late/leftover grant can still be cashable), OR a live
  // one-off grant — a SEPARATE track that stays bookable with no weekly grant at all
  // (seniorsCore.activeOneoffs has already filtered these to live, future windows,
  // and SeniorBookSection renders every one of them as a bookable card).
  if (data.senior) return data.senior.remaining > 0 || (data.senior.oneoffs || []).length > 0;
  return (
    !!bookingHref('ryan', data.meetingType) ||
    !!bookingHref('aaron', data.aaronMeetingType) ||
    (!!data.isART && !!data.artTokenAvailable)
  );
}

// True when this week's check-in is still outstanding.
export function hasCheckinDue(data) {
  if (!data) return false;
  // Seniors have a single weekly check-in. Nudge on the WEEKLY signal
  // (checkedInThisWeek, the current Saturday-week), NOT hasGrant — a grant carried
  // from last week must not suppress this week's nudge (which is what let the badge
  // go quiet while the weekly reminder still emailed). See home-data seniorContext.
  if (data.senior) return !data.senior.checkedInThisWeek;
  // Not in the cadence → nothing is owed, so nothing to nudge. Everyone still IN it
  // keeps the standing nudge, including students who have never checked in — for
  // them it is the intended prod, and it is what surfaces the stalled ones.
  // Deliberately AFTER the senior branch: a senior's check-in is their booking gate,
  // so a stray BE=FALSE must not be able to silence the one nudge that unlocks them.
  if (skipsCheckins(data)) return false;
  return !checkedInThisWeek(data.lastCheckin) || !checkedInThisWeek(data.aaronLastCheckin);
}
