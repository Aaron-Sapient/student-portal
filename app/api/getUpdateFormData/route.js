import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
// Shared with the POST side so the range the form READS and the range the submit
// WRITES can never disagree — the POST recomputes rather than trusting the client.
import { getCurrentSemester, getGradeRanges } from '@/lib/checkinIdentity';
import { getStudentByEmail, getStudentProfile, studentDisplay } from '@/lib/identity';
import { isPortalNative } from '@/lib/provisioning';

// The transcript grid (🎓 Transcript on the STUDENT sheet) is still read from
// Sheets below — that domain's Supabase reader (lib/transcript.js) is the §4
// sweep's job, not this route's. Built lazily, AFTER the skip gate, so the
// summer / MS / unknown-year path never touches Google at all.
function getStudentSheetsClient() {
  const authClient = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: authClient });
}

export async function GET() {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // 1. Identity from Supabase `students` (record of truth, ruling 2026-08-27).
    //    No Master read — the old A:AY scan is gone, and with it the row index the
    //    client used to echo back. The POST (lib/checkinIdentity.js
    //    resolveCheckinStudent) derives its own write target from the session and
    //    never trusted that echo, so `studentRowIndex` is kept in the payload
    //    shape as null only so the client's pass-through keeps working.
    const student = await getStudentByEmail(email);
    if (!student) return Response.json({ error: 'Student not found' }, { status: 404 });

    const studentSheetId = student.student_sheet_id;
    if (!studentSheetId) return Response.json({ error: 'No student sheet found' }, { status: 404 });
    const lastSubmitted = student.last_ryan_checkin ?? null; // was Master AY
    const studentRowIndex = null;

    // 2. Name + grade year from the 🔎 Overview mirror (student_profiles), degraded
    //    to students.name / students.grade when the profile row is missing — never
    //    fatal. A sheet with no 🔎 Overview tab used to 500 the whole form load
    //    (Ryan Koo, 2026-08-26); now the grade is simply unknown and the skip path
    //    below handles it.
    const profile = await getStudentProfile(studentSheetId);
    const { studentName, currentYear: gradeYear } = studentDisplay(student, profile);
    const semester = getCurrentSemester();

    // Skip Q1 for MS/summer but still show Q2+Q3.
    //
    // isPortalNative rides the SAME gate on purpose. A portal-native student
    // (phase 2b, student_sheet_id 'portal:<slug>') has no Google spreadsheet, so
    // the transcript read below would hand Google a garbage spreadsheetId and 500
    // the whole check-in form. They survive today only because their `class` is
    // null, which makes gradeYear null and lands them here by accident — the moment
    // anyone fills in a class and a current_year they would break. Making it
    // explicit means the check-in still WORKS for them, minus the grades step,
    // which is exactly what the skip path is for.
    if (
      semester === 'NA' ||
      gradeYear === 'MS' ||
      !['9th','10th','11th','12th'].includes(gradeYear) ||
      isPortalNative(studentSheetId)
    ) {
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

    // 3. Get class names and grades (student sheet — see getStudentSheetsClient)
    const { namesRange, gradesRange } = getGradeRanges(gradeYear, semester);
    const sheets = getStudentSheetsClient();

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
