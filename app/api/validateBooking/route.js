import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKINS_TAB = '✅ Check-Ins';

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

    // 1. Read student row from 👩‍🎓 All Data
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:AZ`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = masterRes.data.values || [];
    const studentRow = rows.find(r => r[9] === email); // col J = index 9
    if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 });

    // Col AZ = index 51 (A=0, Z=25, AA=26, AZ=51)
const decision = studentRow[51] || null;

// Get student sheet ID from col G (index 6) to fetch real name
const studentSheetUrl = studentRow[6];
const sheetIdMatch = studentSheetUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/);
if (!sheetIdMatch) return Response.json({ error: 'No student sheet found' }, { status: 404 });
const studentSheetId = sheetIdMatch[1];

const nameRes = await sheets.spreadsheets.values.get({
  spreadsheetId: studentSheetId,
  range: '🔎 Overview!B2',
  valueRenderOption: 'UNFORMATTED_VALUE',
});
const studentName = nameRes.data.values?.[0]?.[0] || '';

    // No valid decision on file
    if (!decision || decision === 'no' || decision === 'written') {
      return Response.json({
        allowed: false,
        reason: decision === 'written'
          ? 'written'
          : 'No booking authorization found. Please complete your weekly check-in first.',
      });
    }

    // 2. Check meeting cap from ✅ Check-Ins
    const checkinRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${CHECKINS_TAB}!A:I`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const checkinRows = checkinRes.data.values || [];
    // Col A = name (index 0), Col H = used this month (index 7), Col I = allowed (index 8)
    const checkinRow = checkinRows.find(r => r[0] === studentName);

    if (checkinRow) {
      const used = parseInt(checkinRow[7]) || 0;
      const allowed = checkinRow[8] !== undefined && checkinRow[8] !== ''
        ? parseInt(checkinRow[8])
        : null; // null = no limit

      if (allowed !== null && used >= allowed) {
        return Response.json({
          allowed: false,
          reason: `You've used all ${allowed} of your allowed meetings this month.`,
        });
      }
    }

    // All clear
    return Response.json({
      allowed: true,
      decision, // '15min' or '30min'
      studentName,
    });

  } catch (err) {
    console.error('validateBooking error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}