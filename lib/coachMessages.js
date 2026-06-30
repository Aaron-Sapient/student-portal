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

// hadRecentMeeting moved to lib/meetings.js (behind the `meetings` read flag, so
// the coach-note gate reads the Supabase meetings mirror once cut over).
