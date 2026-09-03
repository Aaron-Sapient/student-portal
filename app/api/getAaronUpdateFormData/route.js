import { auth } from '@clerk/nextjs/server';
import { getStudentByEmail, getStudentProfile, studentDisplay } from '@/lib/identity';

// The Aaron check-in form's preamble: has this student already checked in this
// week, and what name does the confirmation greet them by.
//
// ZERO-GOOGLE (Package D, 2026-09-02). Was two Sheets reads — a Master A:BB scan
// for the row (email col J, last-submitted col BA, portal URL col G) and then
// 🔎 Overview!B2 on the student's own sheet for the name. Both are roster reads
// now, and `studentRowIndex` is gone from the payload: the POST derives its own
// write target from the session and never trusted the client's echo, so the field
// only survives as an explicit null while the form components still forward it.
export async function GET() {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const student = await getStudentByEmail(email);
    if (!student) return Response.json({ error: 'Student not found' }, { status: 404 });
    if (!student.student_sheet_id) {
      return Response.json({ error: 'No student sheet found' }, { status: 404 });
    }

    // display_name mirrors 🔎 Overview!B2 VERBATIM; a missing profile row degrades
    // to the roster spelling instead of 500-ing the form (Ryan Koo, 2026-08-26).
    const profile = await getStudentProfile(student.student_sheet_id);
    const { studentName } = studentDisplay(student, profile);

    return Response.json({
      lastSubmitted: student.last_aaron_checkin ?? null, // was Master col BA
      studentRowIndex: null,
      studentName,
    });

  } catch (err) {
    console.error('getAaronUpdateFormData error:', err);
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
}
