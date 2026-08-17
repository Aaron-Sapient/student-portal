import { google } from 'googleapis';
import { requireAdmin } from '@/lib/developerAuth';
import { getInstructor } from '@/lib/instructors';
import { createProjectPlan, findActiveDuplicatePlan } from '@/lib/projectMeetings';
import { validateSession, formatSession } from '@/lib/sessionSpec';
import { sendProjectMeetingGrantedEmail } from '@/lib/checkinEmails';

// Admin tool (stopgap): give a student a STANDING weekly "project meeting" (solo
// research, etc.) — a separate, additive track from the senior essay cadence and the
// one-off track. Creates a project_meeting_plans row; the student then sees a "Project
// meeting" card in their Meetings tab and books it once per week. Works for seniors AND
// non-seniors. requireAdmin → Ryan + Aaron.
//
// Future: this becomes "assign a student to a project (with a lead/co-lead role)"; the
// plan row is the seed of that model. Not built yet — see supabase/project_meetings.sql.

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

export async function POST(request) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { studentSheetId, instructor: instructorSlug, minutes, label, note, notify } = body;
  if (!studentSheetId) return Response.json({ error: 'Missing studentSheetId' }, { status: 400 });

  // ONE rule set for teacher / length / label, shared with the developer panel's form
  // and scripts/sessions.mjs (lib/sessionSpec.js) — so a plan that is legal from the CLI
  // is legal here and vice-versa. Before this the route's own list lagged the real
  // packages (15/30, then 15/30/45/60) and longer plans were hand-inserted around it.
  const v = validateSession({ teacher: instructorSlug || 'aaron', minutes, label: label || 'Solo Research' });
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const { teacher: slug, minutes: mins, label: cleanLabel } = v.value;
  const instructor = getInstructor(slug);

  try {
    // Resolve the student from the Master sheet by sheet id (portal URL, col G) for the
    // email identity (A=name, J=email, K/L=parent emails).
    const authClient = getServiceAuth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID,
      range: `${MASTER_TAB}!A:L`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const rows = masterRes.data.values || [];
    const row = rows.find((r) => String(r[6] || '').includes(studentSheetId)) || null;
    if (!row) return Response.json({ error: 'Student not found in the Master sheet' }, { status: 404 });

    const studentName = (row[0] || '').trim();
    const studentEmail = (row[9] || '').trim();
    const parentEmails = [row[10], row[11]].filter((e) => e && String(e).includes('@'));

    // A second identical ACTIVE plan is not a no-op: the 1/week cap is per plan, so it
    // silently doubles the student's weekly meetings (that is exactly how one student
    // ended up with 2×30 Solo Research). Refuse unless the caller says it's deliberate.
    const dupe = await findActiveDuplicatePlan(studentSheetId, v.value);
    if (dupe && body.allowDuplicate !== true) {
      return Response.json({
        error: `${studentName || 'This student'} already has an active ${formatSession(v.value)} plan (${dupe.id}). Adding another would let them book it twice a week — give it a different label (e.g. “… B”) if they really need two.`,
        duplicateOf: dupe.id,
      }, { status: 409 });
    }

    const plan = await createProjectPlan({
      studentSheetId,
      studentEmail: studentEmail || null,
      teacher: slug,
      minutes: mins,
      label: cleanLabel,
      note: note?.trim() || null,
      grantedBy: gate.email,
    });

    // Best-effort email (the plan already exists; a mail failure shouldn't 500). Default
    // on; pass notify:false to create the plan silently.
    let emailed = false;
    if (notify !== false && studentEmail) {
      try {
        await sendProjectMeetingGrantedEmail({
          studentEmail,
          parentEmails,
          studentName,
          label: cleanLabel,
          minutes: mins,
          teacherSlug: slug,
          teacherName: instructor.displayName,
          planId: plan.id,
        });
        emailed = true;
      } catch (emailErr) {
        console.error('grantProjectMeeting: email failed (non-fatal):', emailErr);
      }
    }

    return Response.json({
      ok: true,
      planId: plan.id,
      studentName,
      instructorName: instructor.displayName,
      minutes: mins,
      label: cleanLabel,
      emailed,
      message:
        `Set up a weekly ${mins}-min ${cleanLabel} with ${instructor.displayName} for ${studentName || 'student'}.` +
        (emailed ? ' Emailed a booking link.' : studentEmail ? ' Email skipped/failed — they’ll see the card in their portal.' : ' No email on file.'),
    });
  } catch (err) {
    console.error('grantProjectMeeting error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
