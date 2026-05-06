import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { requireDeveloper } from '@/lib/developerAuth';

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
    // Google Sheets serial date.
    dt = DateTime.fromMillis((raw - 25569) * 86400 * 1000).setZone('America/Los_Angeles');
  } else {
    dt = DateTime.fromISO(String(raw)).setZone('America/Los_Angeles');
  }
  return dt.isValid ? dt : null;
}

export async function GET() {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });

    // Pull the whole master block in one call. Indices (0-based, range starts at A):
    //   A=0 (student name), B=1 (year — do NOT use as name), J=9 (email),
    //   AY=50 (Ryan last check-in), BA=52 (Aaron last check-in)
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:BD`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = res.data.values || [];
    const dataRows = rows.slice(1); // drop header

    const now = DateTime.now().setZone('America/Los_Angeles');
    const cutoff = now.minus({ days: 14 });

    const students = dataRows
      .map(r => {
        const email = r[9] || '';
        const name = r[0] || '';
        if (!email) return null;
        const ryanDt = parseTimestamp(r[50]);
        const aaronDt = parseTimestamp(r[52]);
        return {
          email,
          name: name || email,
          lastRyan: ryanDt ? ryanDt.toISO() : null,
          lastAaron: aaronDt ? aaronDt.toISO() : null,
          daysSinceRyan: ryanDt ? Math.floor(now.diff(ryanDt, 'days').days) : null,
          daysSinceAaron: aaronDt ? Math.floor(now.diff(aaronDt, 'days').days) : null,
          missingRyan: !ryanDt || ryanDt < cutoff,
          missingAaron: !aaronDt || aaronDt < cutoff,
        };
      })
      .filter(Boolean);

    return Response.json({ students, cutoffDays: 14 });
  } catch (err) {
    console.error('checkinCompliance error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
