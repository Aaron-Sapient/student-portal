import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
// Shared with the POST side so the range the form READS and the range the submit
// WRITES can never disagree — the POST recomputes rather than trusting the client.
import { getCurrentSemester, getGradeRanges } from '@/lib/checkinIdentity';

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
    // Non-fatal by design (mirrors lib/checkinIdentity.js): a sheet with no
    // 🔎 Overview tab used to 500 the whole form load; now the grade is unknown
    // (the skip path below handles it) and the name falls back to the roster.
    const optionalCell = (range) =>
      sheets.spreadsheets.values
        .get({ spreadsheetId: studentSheetId, range, valueRenderOption: 'UNFORMATTED_VALUE' })
        .then((r) => r.data.values?.[0]?.[0])
        .catch((err) => {
          console.error('[getUpdateFormData] Overview read failed:', range, err?.message);
          return undefined;
        });
    const [gradeYear, overviewName] = await Promise.all([
      optionalCell('🔎 Overview!C4'),
      optionalCell('🔎 Overview!B2'),
    ]);
    const studentName = overviewName || String(studentRow[0] ?? '').trim();
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