import { requireAdmin } from '@/lib/developerAuth';
import { getStudentContactBySheetId } from '@/lib/identity';
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
    // Email identity from `students` + `guardians` (was a Master A:L scan matched on
    // col G containing the sheet id).
    const contact = await getStudentContactBySheetId(studentSheetId);
    if (!contact) return Response.json({ error: 'Student not found' }, { status: 404 });

    const { name: studentName, studentEmail, parentEmails } = contact;

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
