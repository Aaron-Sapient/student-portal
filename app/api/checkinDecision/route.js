import { google } from 'googleapis';
import { verifyApprovalToken, actionToDecision } from '@/lib/checkinApproval';
import { sendMeetingGrantedEmail } from '@/lib/checkinEmails';
import { triggerReportGeneration } from '@/lib/generateReport';

// Applies Ryan's emailed meeting decision. PUBLIC route (Ryan clicks from his
// inbox with no Clerk session) — authorization is the HMAC-signed token, not a
// session. Mutating only on POST keeps email link-scanners/prefetch from firing
// an action; the GET confirmation page never reaches here.

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKIN_TAB = 'CheckinForm';

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
  let token;
  try {
    ({ token } = await request.json());
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }

  const payload = verifyApprovalToken(token);
  if (!payload) return Response.json({ error: 'Invalid or expired link' }, { status: 401 });

  const { action, masterRow, checkinRow, studentSheetId, studentName } = payload;

  try {
    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });

    // Lock vs. overwrite: once the student has actually booked, bookMeeting sets
    // the Master AZ token to 'no' — at that point the decision is final. Until
    // then Ryan may change his mind: re-clicking a *different* button overwrites
    // the earlier decision; re-clicking the *same* one is a no-op (so the
    // student isn't emailed twice). We gate on AZ (the live booking state), not
    // the CheckinForm status, so a prior grant/reject can still be revised.
    const decision = actionToDecision(action); // '15min' | '30min' | 'written'

    const azRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!AZ${masterRow}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const currentAZ = String(azRes.data.values?.[0]?.[0] || '').trim();

    if (currentAZ === 'no') {
      // Student already booked this meeting — a later click can't change it.
      return Response.json({ status: 'booked', studentName });
    }
    if (currentAZ === decision) {
      // Already set to this decision — no-op so we don't re-email the student.
      return Response.json({ status: 'already', resolvedAs: decision, studentName });
    }

    // Mark the check-in resolved (col L) and set the booking gate (Master AZ).
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: MASTER_SHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${CHECKIN_TAB}!L${checkinRow}`, values: [[decision]] },
          { range: `${MASTER_TAB}!AZ${masterRow}`, values: [[decision]] },
        ],
      },
    });

    if (action === 'reject') {
      // No email on rejection — just generate the written report.
      await triggerReportGeneration(studentName, studentSheetId);
      return Response.json({ status: 'rejected', studentName });
    }

    // Grant: email the student (CC parents) the booking link. Pull J/K/L for the
    // student's master row (J=student, K=parent1, L=parent2).
    let studentEmail = '';
    let parentEmails = [];
    try {
      const emailsRes = await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!J${masterRow}:L${masterRow}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
      const row = emailsRes.data.values?.[0] || [];
      studentEmail = String(row[0] || '').trim();
      parentEmails = [row[1], row[2]].map((e) => String(e || '').trim()).filter(Boolean);
    } catch (e) {
      console.error('checkinDecision: failed to read student/parent emails', e);
    }

    if (studentEmail) {
      try {
        await sendMeetingGrantedEmail({ studentEmail, parentEmails, studentName, decision });
      } catch (mailErr) {
        console.error('checkinDecision: failed to send grant email', mailErr);
        // Token is already written, so the student can still book from the
        // portal; surface a soft warning rather than failing the grant.
        return Response.json({ status: 'granted', decision, studentName, emailFailed: true });
      }
    }

    return Response.json({ status: 'granted', decision, studentName, emailFailed: !studentEmail });
  } catch (err) {
    console.error('checkinDecision error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
