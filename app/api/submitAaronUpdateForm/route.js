import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { listBlocksForBooking, isDateBlocked } from '@/lib/blocks';
import { mirrorBookingToken, resolveStudentSheetId } from '@/lib/bookingTokens';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKIN_TAB = 'A_CheckinForm';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const {
      studentRowIndex,
      studentName,
      taskUpdates,         // [{ task, status }]
      upcomingDeadlines,
      questionsCategory,
      questionsText,
      responsePreference,
    } = body;

    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const now = new Date().toISOString();

    // ── 1. Overwrite BA timestamp in 👩‍🎓 All Data ───────────────────────────
    await sheets.spreadsheets.values.update({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!BA${studentRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[now]] },
    });

    // ── 2. Build concatenated task-updates string ────────────────────────────
    const taskUpdatesString = (taskUpdates || [])
      .map(({ task, status }) => `${task}: ${status}`)
      .join('; ');

    // ── 3. Append new row to A_CheckinForm ───────────────────────────────────
    // Column order: A=Timestamp, B=Name, C=Task Updates, D=Upcoming Deadlines,
    // E=Questions Category, F=Questions Text, G=Response Preference,
    // H=Agenda (filled later by bookMeeting), I=Routing Reason, J=Booking Decision
    await sheets.spreadsheets.values.append({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${CHECKIN_TAB}!A:J`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          now,                        // A: Timestamp
          studentName || '',          // B: Name
          taskUpdatesString,          // C: Task Updates (concatenated)
          upcomingDeadlines || '',    // D: Upcoming Deadlines
          questionsCategory || '',    // E: Questions Category
          questionsText || '',        // F: Questions Text
          responsePreference || '',   // G: Response Preference
          '',                         // H: Agenda (filled by bookMeeting)
          '',                         // I: Routing Reason (filled below)
          '',                         // J: Booking Decision (filled below)
        ]],
      },
    });

    // ── 4. Routing: honor the student's explicit choice exactly.
    // Aaron's flow is deterministic — no Claude, no judgment, no escalation.
    // The only override is a real calendar constraint (Aaron blocked today).
    const PREFERENCE_TO_DECISION = {
      '15min': '15min',
      '30min': '30min',
      'Ready to finalize over email': 'email',
    };

    let decision = PREFERENCE_TO_DECISION[responsePreference] || '15min';
    let reason = `Student selected ${responsePreference || '15min (default)'}.`;

    const today = DateTime.now().setZone('America/Los_Angeles').toFormat('yyyy-LL-dd');
    const blocks = await listBlocksForBooking(sheets).catch(() => []);
    if (isDateBlocked(blocks, 'aaron', today)) {
      decision = 'email';
      reason = 'Aaron is unavailable today — finalize over email this week.';
    }

    // ── 5. Write booking decision to 👩‍🎓 All Data col BB ──────────────────
    await sheets.spreadsheets.values.update({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!BB${studentRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[decision]] },
    });

    // Best-effort mirror to the booking_tokens cutover table (Aaron/BB; read side
    // stays on Sheets). Resolve sheetId via a separate col-G read (rowIndex only here).
    const aaronSid = await resolveStudentSheetId(sheets, studentRowIndex);
    await mirrorBookingToken({ studentSheetId: aaronSid, slug: 'aaron', value: decision });

    // ── 6. Backfill routing reason (col I) and decision (col J) on the appended row ──
    const allRowsRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${CHECKIN_TAB}!A:J`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const checkinRows = allRowsRes.data.values || [];
    let lastMatchIndex = -1;
    checkinRows.forEach((r, i) => {
      if (r[1] === studentName) lastMatchIndex = i;
    });

    if (lastMatchIndex > -1) {
      const sheetRow = lastMatchIndex + 1;
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: MASTER_SHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: [
            { range: `${CHECKIN_TAB}!I${sheetRow}`, values: [[reason || '']] },
            { range: `${CHECKIN_TAB}!J${sheetRow}`, values: [[decision]] },
          ],
        },
      });
    }

    return Response.json({ success: true, decision, reason });

  } catch (err) {
    console.error('submitAaronUpdateForm error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
