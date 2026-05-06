import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { requireDeveloper } from '@/lib/developerAuth';
import { sendCheckinReminderEmail } from '@/lib/studentEmails';
import { INSTRUCTORS } from '@/lib/instructors';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

function parseTimestamp(raw) {
  if (!raw) return null;
  let dt;
  if (typeof raw === 'number') {
    dt = DateTime.fromMillis((raw - 25569) * 86400 * 1000).setZone('America/Los_Angeles');
  } else {
    dt = DateTime.fromISO(String(raw)).setZone('America/Los_Angeles');
  }
  return dt.isValid ? dt : null;
}

export async function POST(request) {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const bccRyan = !!body.bccRyan;
  const bccAaron = !!body.bccAaron;
  if (!bccRyan && !bccAaron) {
    return Response.json({ error: 'At least one BCC target required' }, { status: 400 });
  }

  const bccList = [];
  if (bccRyan) bccList.push(INSTRUCTORS.ryan.cancelEmail);
  if (bccAaron) bccList.push(INSTRUCTORS.aaron.cancelEmail);

  try {
    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:BD`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const dataRows = (res.data.values || []).slice(1);
    const now = DateTime.now().setZone('America/Los_Angeles');
    const cutoff = now.minus({ days: 14 });

    const recipients = [];
    for (const r of dataRows) {
      const email = (r[9] || '').trim();
      const name = (r[0] || '').trim();
      if (!email) continue;
      const ryanDt = parseTimestamp(r[50]);
      const aaronDt = parseTimestamp(r[52]);
      const missingRyan = !ryanDt || ryanDt < cutoff;
      const missingAaron = !aaronDt || aaronDt < cutoff;
      // Recipient list interpretation: behind on at least one weekly check-in.
      // If the user wants strictly "no check-in at all", change to (missingRyan && missingAaron).
      if (missingRyan || missingAaron) {
        recipients.push({ email, name: name || email });
      }
    }

    const sent = [];
    const failed = [];
    // Sequential to avoid hammering SMTP and to keep BCC headers tidy.
    for (const r of recipients) {
      try {
        await sendCheckinReminderEmail({
          to: r.email,
          studentName: r.name,
          bcc: bccList,
        });
        sent.push(r.email);
      } catch (err) {
        console.error('reminder send failed for', r.email, err);
        failed.push({ email: r.email, error: err.message });
      }
    }

    return Response.json({
      sentCount: sent.length,
      failedCount: failed.length,
      total: recipients.length,
      bcc: bccList,
      failed,
    });
  } catch (err) {
    console.error('sendCheckinReminders error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
