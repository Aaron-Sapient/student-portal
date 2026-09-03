import { auth } from '@clerk/nextjs/server';
import { DateTime } from 'luxon';
import { getGoogleSheetsClient } from '@/lib/google';
import { getStudentByEmail } from '@/lib/identity';
import { getCoachMessage } from '@/lib/coachMessages';
import { hadRecentMeeting } from '@/lib/meetings';
import { getSheetCoachNote } from '@/lib/scores';
import { studentGradeGate } from '@/lib/transcript';

// Resolve the student's sheet ID + Class from `students` (record of truth). The
// Master A:BD scan is gone; student_sheet_id IS the value the portal-URL regex
// used to extract, and `class` is the same raw Class cell the old row[1] carried.
async function resolveStudent(email) {
  if (!email) return { sheetId: null, cls: null };
  const student = await getStudentByEmail(email);
  return { sheetId: student?.student_sheet_id ?? null, cls: student?.class ?? null };
}

// Suppress the coach note when the student has no recent recorded grades —
// the score dashboard is grayed out for them, so a live "nice work" note would
// read inconsistently. Fails open (shows the note) if the transcript is
// unreadable — never hide a note over a transient read error.
async function hasEnoughGradeData(sheets, sheetId, cls) {
  if (!sheetId) return true;
  try {
    const now = DateTime.now().setZone('America/Los_Angeles');
    // Flag-gated gate (Sheets today); a read error throws → caught → fail OPEN (true).
    return (await studentGradeGate(sheets, sheetId, cls, { year: now.year, month: now.month })).enough;
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
    // `sheets` still serves the three student-sheet readers below (coach note,
    // meeting recency, grade gate) — the comps/scores/transcript/meetings lanes.
    const sheets = getGoogleSheetsClient(email);
    const { sheetId: studentSheetId, cls } = await resolveStudent(email);
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
