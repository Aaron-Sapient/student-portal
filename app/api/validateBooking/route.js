import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { getInstructor } from '@/lib/instructors';

const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKINS_TAB = '✅ Check-Ins';

// Master-sheet column indices (A=0). AY=50, AZ=51, BA=52, BB=53, BC=54, BD=55.
const COLUMN_INDEX = { ryan: 51, aaron: 53, art: 55 };
const NON_BOOKABLE_VALUE = { ryan: 'written', aaron: 'email' };
const IS_ART_COL = 54;

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function mostRecentSaturdayLA() {
  const now = DateTime.now().setZone('America/Los_Angeles');
  let sat = now.set({ weekday: 6 });
  if (now.weekday < 6) sat = sat.minus({ weeks: 1 });
  return sat.startOf('day');
}

export async function GET(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const instructor = getInstructor(searchParams.get('instructor'));

  try {
    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:BD`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = masterRes.data.values || [];
    const studentRow = rows.find(r => r[9] === email); // col J = index 9
    if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 });

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

    // ART path: requires BC=TRUE, and BD either empty or older than this week's Saturday.
    if (instructor.slug === 'art') {
      const isART = studentRow[IS_ART_COL] === 'TRUE' || studentRow[IS_ART_COL] === true;
      if (!isART) {
        return Response.json({ allowed: false, reason: 'Not part of the Advanced Research Team.' });
      }
      const bdValue = studentRow[COLUMN_INDEX.art] || '';
      if (bdValue) {
        const bookingDate = DateTime.fromISO(String(bdValue)).setZone('America/Los_Angeles');
        if (bookingDate.isValid && bookingDate >= mostRecentSaturdayLA()) {
          return Response.json({
            allowed: false,
            reason: 'You\'ve already booked your ART meeting this week.',
          });
        }
      }
      return Response.json({ allowed: true, decision: '15min', studentName });
    }

    // Standard path (Ryan / Aaron): decision string drives gating.
    const decision = studentRow[COLUMN_INDEX[instructor.slug]] || null;
    const nonBookable = NON_BOOKABLE_VALUE[instructor.slug];

    if (!decision || decision === 'no' || decision === nonBookable) {
      return Response.json({
        allowed: false,
        reason: decision === nonBookable
          ? nonBookable
          : 'No booking authorization found. Please complete your weekly check-in first.',
      });
    }

    // Meeting cap (Ryan only)
    if (instructor.slug === 'ryan') {
      const checkinRes = await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${CHECKINS_TAB}!A:I`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });

      const checkinRows = checkinRes.data.values || [];
      const checkinRow = checkinRows.find(r => r[0] === studentName);

      if (checkinRow) {
        const used = parseInt(checkinRow[7]) || 0;
        const allowed = checkinRow[8] !== undefined && checkinRow[8] !== ''
          ? parseInt(checkinRow[8])
          : null;

        if (allowed !== null && used >= allowed) {
          return Response.json({
            allowed: false,
            reason: `You've used all ${allowed} of your allowed meetings this month.`,
          });
        }
      }
    }

    return Response.json({
      allowed: true,
      decision,
      studentName,
    });

  } catch (err) {
    console.error('validateBooking error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
