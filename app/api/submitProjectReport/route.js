import { auth } from '@clerk/nextjs/server';
import { DateTime } from 'luxon';
import { getGoogleSheetsClient } from '@/lib/google';
import { resolveIdentity, sessionEmail } from '@/lib/identity';
import { getSupabaseClient, PROJECT_REPORTS } from '@/lib/supabase';

// Student "report in" for the summer group-project census. A student can be in
// MULTIPLE group projects → one row per (student, project_index). Raw intake only;
// fuzzy team/roster reconciliation + booking-token grants happen downstream, not
// here. Supabase is authoritative; no Sheets mirror.
//
// response per row: 'finalized' (full report) | 'not_finalized' (on it, roster not
// set → email Ryan) | 'no_project' (a single marker row: student is on no project).

function sheetIdFromPortalUrl(url) {
  const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

// The logged-in STUDENT (not a parent viewing on their behalf).
async function resolveStudent() {
  const { sessionClaims } = await auth();
  const email = sessionEmail(sessionClaims);
  if (!email) return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) };

  const sheets = getGoogleSheetsClient(email);
  const identity = await resolveIdentity(sheets, email);
  if (identity.role !== 'student') {
    return { error: Response.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  const row = identity.studentRow || [];
  const sheetId = sheetIdFromPortalUrl(row[6]);
  if (!sheetId) {
    return { error: Response.json({ error: 'No student sheet on record' }, { status: 404 }) };
  }
  return {
    email,
    sheetId,
    name: String(row[0] ?? '').trim(),
    studentClass: String(row[1] ?? '').trim(),
  };
}

function toProject(r) {
  return {
    projectName: r.project_name || '',
    projectPlan: r.project_plan || '',
    teamMembers: r.team_members || '',
    timeline: r.timeline || '',
    preferredTime: r.preferred_time || '',
    finalized: r.response === 'finalized',
  };
}

export async function GET() {
  const resolved = await resolveStudent();
  if (resolved.error) return resolved.error;
  const { sheetId } = resolved;

  const sb = getSupabaseClient();
  const { data: rows, error } = await sb
    .from(PROJECT_REPORTS)
    .select('*')
    .eq('student_sheet_id', sheetId)
    .order('project_index', { ascending: true });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const list = rows || [];
  if (list.length === 0) {
    return Response.json({ submitted: false, response: 'none', projects: [] });
  }
  if (list.length === 1 && list[0].response === 'no_project') {
    return Response.json({ submitted: true, response: 'no_project', projects: [] });
  }
  const projects = list.filter((r) => r.response !== 'no_project').map(toProject);
  return Response.json({ submitted: true, response: 'in_project', projects });
}

export async function POST(request) {
  const resolved = await resolveStudent();
  if (resolved.error) return resolved.error;
  const { email, sheetId, name, studentClass } = resolved;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const clean = (v) => String(v ?? '').trim();
  const sb = getSupabaseClient();
  const base = {
    student_sheet_id: sheetId,
    student_email: email,
    student_name: name,
    student_class: studentClass,
    updated_at: DateTime.utc().toISO(),
  };

  // Replace the student's whole set safely: upsert the current rows FIRST (never a
  // window where their data is gone), then delete any trailing rows they dropped.
  async function replaceWith(rows) {
    const { error: upErr } = await sb
      .from(PROJECT_REPORTS)
      .upsert(rows, { onConflict: 'student_sheet_id,project_index' });
    if (upErr) return upErr;
    const { error: delErr } = await sb
      .from(PROJECT_REPORTS)
      .delete()
      .eq('student_sheet_id', sheetId)
      .gte('project_index', rows.length);
    return delErr || null;
  }

  // Not on any group project → a single marker row.
  if (body?.inProject === false) {
    const err = await replaceWith([
      {
        ...base,
        project_index: 0,
        response: 'no_project',
        project_name: null,
        project_plan: null,
        team_members: null,
        timeline: null,
        preferred_time: null,
      },
    ]);
    if (err) return Response.json({ error: err.message }, { status: 500 });
    return Response.json({ success: true, response: 'no_project' });
  }

  // On one or more group projects → one row per project.
  const raw = Array.isArray(body?.projects) ? body.projects : [];
  if (raw.length === 0) {
    return Response.json({ error: 'Add at least one project.' }, { status: 400 });
  }
  const rows = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const projectName = clean(p?.projectName);
    if (!projectName) {
      return Response.json({ error: `Project ${i + 1} needs a name.` }, { status: 400 });
    }
    const finalized = p?.finalized !== false; // default true unless explicitly false
    if (finalized) {
      const projectPlan = clean(p?.projectPlan);
      const teamMembers = clean(p?.teamMembers);
      const timeline = clean(p?.timeline);
      if (!projectPlan || !teamMembers || !timeline) {
        return Response.json(
          {
            error: `"${projectName}" needs a plan, team members, and timeline — or mark its roster as not finalized.`,
          },
          { status: 400 }
        );
      }
      rows.push({
        ...base,
        project_index: i,
        response: 'finalized',
        project_name: projectName,
        project_plan: projectPlan,
        team_members: teamMembers,
        timeline,
        preferred_time: clean(p?.preferredTime) || null,
      });
    } else {
      rows.push({
        ...base,
        project_index: i,
        response: 'not_finalized',
        project_name: projectName,
        project_plan: clean(p?.projectPlan) || null,
        team_members: clean(p?.teamMembers) || null,
        timeline: clean(p?.timeline) || null,
        preferred_time: clean(p?.preferredTime) || null,
      });
    }
  }

  const err = await replaceWith(rows);
  if (err) return Response.json({ error: err.message }, { status: 500 });
  return Response.json({ success: true, response: 'in_project' });
}
