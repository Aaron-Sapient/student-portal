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

function getCurrentSemester() {
  const month = new Date().getMonth() + 1;
  if (month >= 6 && month <= 8) return 'NA';
  if (month >= 9 && month <= 12) return 'S1';
  return 'S2';
}

function getGradeRanges(gradeYear, semester) {
  const gradeCol = {
    S1: { '9th': 'H', '10th': 'H', '11th': 'S', '12th': 'S' },
    S2: { '9th': 'K', '10th': 'K', '11th': 'V', '12th': 'V' },
  };
  const nameCol = { '9th': 'E', '10th': 'E', '11th': 'P', '12th': 'P' };
  const rows = { '9th': [6, 15], '10th': [24, 33], '11th': [6, 15], '12th': [24, 33] };

  const [startRow, endRow] = rows[gradeYear];
  const nCol = nameCol[gradeYear];
  const gCol = gradeCol[semester][gradeYear];

  return {
    namesRange: `🎓 Transcript!${nCol}${startRow}:${nCol}${endRow}`,
    gradesRange: `🎓 Transcript!${gCol}${startRow}:${gCol}${endRow}`,
  };
}

export async function GET() {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // 1. Find student row in master sheet
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:AY`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = masterRes.data.values || [];
    const studentRow = rows.find(r => r[9] === email); // col J = index 9
    if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 });

    const studentSheetUrl = studentRow[6]; // col G = index 6
    const lastSubmitted = studentRow[50] || null; // col AY = index 50
    const studentRowIndex = rows.indexOf(studentRow) + 1;

    // 2. Extract student sheet ID from URL
    const sheetIdMatch = studentSheetUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) return Response.json({ error: 'No student sheet found' }, { status: 404 });
    const studentSheetId = sheetIdMatch[1];

    // 3. Get student name and grade year in parallel
    const [overviewRes, nameRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: studentSheetId,
        range: '🔎 Overview!C4',
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: studentSheetId,
        range: '🔎 Overview!B2',
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
    ]);

    const gradeYear = overviewRes.data.values?.[0]?.[0];
    const studentName = nameRes.data.values?.[0]?.[0] || '';
    const semester = getCurrentSemester();

    // Skip Q1 for MS/summer but still show Q2+Q3
    if (semester === 'NA' || gradeYear === 'MS' || !['9th','10th','11th','12th'].includes(gradeYear)) {
      return Response.json({
        skip: true,
        lastSubmitted,
        studentRowIndex,
        gradeYear,
        semester,
        studentName,
        studentSheetId,
      });
    }

    // 4. Get class names and grades
    const { namesRange, gradesRange } = getGradeRanges(gradeYear, semester);

    const [namesRes, gradesRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: studentSheetId,
        range: namesRange,
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: studentSheetId,
        range: gradesRange,
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
    ]);

    const nameValues = namesRes.data.values || [];
    const gradeValues = gradesRes.data.values || [];

    const classes = nameValues
      .map((nameRow, i) => ({
        name: nameRow[0] || null,
        grade: gradeValues[i]?.[0] || null,
        rowOffset: i,
      }))
      .filter(c => c.name);

    return Response.json({
      skip: false,
      gradeYear,
      semester,
      classes,
      lastSubmitted,
      studentRowIndex,
      studentSheetId,
      gradesRange,
      studentName,
    });

  } catch (err) {
    console.error('getUpdateFormData error:', err);
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
}