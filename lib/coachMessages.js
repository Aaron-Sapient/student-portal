import { DateTime } from 'luxon';

const ZONE = 'America/Los_Angeles';

// Claude Coach — supportive, time-sensitive notes surfaced on the portal Home
// tab. Tone is always warm and forward-looking, NEVER punitive: it celebrates
// momentum and reframes deadlines as finish lines, never scolds for gaps.
//
// Keyed by the student's portal login email. Today these are seeded by hand for
// a demo account. The production path (not built yet) is a NAS cron that audits
// each student's sheet twice daily and writes a fresh entry here — or to a Sheet
// tab this module reads — so the API/UI below don't change when it lands.

export const COACH_MESSAGES = {
  // Demo: shown on the Test2 account (aaronblumenthal21@gmail.com).
  // Grounded in Kyle Wan's current sheet — John Locke '26 now ✅ (submitted), and
  // the Written Reports show a heavy May of AP exams (Chem, Calc BC, HUG) just done.
  'aaronblumenthal21@gmail.com': {
    author: 'Claude Coach',
    message:
      'John Locke is in, and the long stretch of May exams is finally behind you. ' +
      "Breathe easy this weekend, Kyle — you've earned the quiet.",
    generatedAt: '2026-05-30T15:19:00-07:00',
    // Rolls over after the weekend (the cron would refresh it twice daily).
    expiresAt: '2026-06-01T09:00:00-07:00',
  },
};

export function getCoachMessage(email) {
  if (!email) return null;
  const m = COACH_MESSAGES[email.toLowerCase()];
  if (!m) return null;
  if (m.expiresAt && new Date(m.expiresAt).getTime() < Date.now()) return null;
  return m;
}

// Mirrors portalUtils.parseSheetDate: Google hands us either a serial number
// (days since 1899-12-30) or a string. Pin both to the LA calendar date.
function parseMeetingDate(raw) {
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

// Gate for the coach note: true iff the student logged a meeting in their
// 📆 Meetings!B2:B within the last 7 days. The Claude message is bypassed
// entirely when this is false. Fails closed (returns false) if the tab is
// missing or unreadable — better to suppress a note than show a stale one.
export async function hadRecentMeeting(sheets, studentSheetId) {
  if (!studentSheetId) return false;
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: "'📆 Meetings'!B2:B",
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
  } catch {
    return false;
  }
  const now = DateTime.now().setZone(ZONE);
  const cutoff = now.minus({ days: 7 }).startOf('day');
  const end = now.endOf('day');
  return (res.data.values || []).some((r) => {
    const dt = parseMeetingDate(r[0]);
    return dt && dt >= cutoff && dt <= end;
  });
}
