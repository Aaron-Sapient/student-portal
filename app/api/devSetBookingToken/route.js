import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';

export async function POST() {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const authClient = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${MASTER_TAB}!J:J`,
  });

  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === email) + 1;
  if (!rowIndex) return Response.json({ error: 'Not found' }, { status: 404 });

  await sheets.spreadsheets.values.update({
    spreadsheetId: MASTER_SHEET_ID,
    range: `${MASTER_TAB}!AZ${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['30min']] },
  });

  return Response.json({ success: true });
}