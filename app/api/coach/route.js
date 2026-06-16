import { auth } from '@clerk/nextjs/server';
import { DateTime } from 'luxon';
import { getGoogleSheetsClient } from '@/lib/google';
import { getCoachMessage, hadRecentMeeting } from '@/lib/coachMessages';
import { getSheetCoachNote } from '@/lib/scores';
import { hasRecentGrades, TRANSCRIPT_GRADE_RANGE } from '@/lib/gradeData';

// Resolve the student's sheet ID + Class from the master sheet. A:BD so col A
// rides along: email col J (9), portal URL col G (6), Class col B (1).
async function resolveStudent(sheets, email) {
  if (!email) return { sheetId: null, cls: null };
  const masterRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: "'👩‍🎓 All Data'!A:BD",
  });
  const row = (masterRes.data.values || []).find(
    (r) => r[9]?.toLowerCase() === email.toLowerCase()
  );
  const sheetIdMatch = row?.[6]?.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return { sheetId: sheetIdMatch?.[1] ?? null, cls: row?.[1] ?? null };
}

// Suppress the coach note when the student has no recent recorded grades —
// the score dashboard is grayed out for them, so a live "nice work" note would
// read inconsistently. Fails open (shows the note) if the transcript is
// unreadable — never hide a note over a transient read error.
async function hasEnoughGradeData(sheets, sheetId, cls) {
  if (!sheetId) return true;
  try {
    const tr = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: TRANSCRIPT_GRADE_RANGE,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const now = DateTime.now().setZone('America/Los_Angeles');
    return hasRecentGrades(tr.data.values || [], cls, { year: now.year, month: now.month }).enough;
  } catch {
    return true;
  }
}

// Returns the current Claude Coach note for the logged-in student, or null.
// Production path: the weekly NAS scoring cron writes the note into the
// student's 📊 Scores tab (lib/scores.getSheetCoachNote, 7-day expiry). The
// hand-seeded map in lib/coachMessages stays as a demo override. Either way,
// the note is bypassed unless the student has a meeting logged in their
// 📆 Meetings!B2:B within the last 7 days.
export async function GET() {
  const { userId, sessionClaims } = await auth();
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const email = sessionClaims?.email ?? sessionClaims?.primary_email_address ?? null;
  const override = getCoachMessage(email);

  try {
    const sheets = getGoogleSheetsClient(email);
    const { sheetId: studentSheetId, cls } = await resolveStudent(sheets, email);
    const message = override ?? (await getSheetCoachNote(sheets, studentSheetId));
    if (!message) return Response.json({ coach: null });
    const recent = await hadRecentMeeting(sheets, studentSheetId);
    if (!recent) return Response.json({ coach: null });
    const enough = await hasEnoughGradeData(sheets, studentSheetId, cls);
    return Response.json({ coach: enough ? message : null });
  } catch {
    // Can't verify recency → fail closed (bypass) rather than risk a stale note.
    return Response.json({ coach: null });
  }
}
