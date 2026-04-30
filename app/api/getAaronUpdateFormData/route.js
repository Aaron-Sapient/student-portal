import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export async function GET() {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:BB`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = masterRes.data.values || [];
    const studentRow = rows.find(r => r[9] === email); // col J = index 9
    if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 });

    const studentRowIndex = rows.indexOf(studentRow) + 1;
    const lastSubmitted = studentRow[52] || null; // col BA = index 52

    const studentSheetUrl = studentRow[6]; // col G = index 6
    const sheetIdMatch = studentSheetUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) return Response.json({ error: 'No student sheet found' }, { status: 404 });
    const studentSheetId = sheetIdMatch[1];

    const nameRes = await sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: '🔎 Overview!B2',
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const studentName = nameRes.data.values?.[0]?.[0] || '';

    return Response.json({
      lastSubmitted,
      studentRowIndex,
      studentName,
    });

  } catch (err) {
    console.error('getAaronUpdateFormData error:', err);
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
}
