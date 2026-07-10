import { auth } from '@clerk/nextjs/server';
import { DateTime } from 'luxon';
import { getGoogleSheetsClient } from '@/lib/google';
import { resolveIdentity, sessionEmail } from '@/lib/identity';
import { getSupabaseClient, PROJECT_REPORTS } from '@/lib/supabase';

// Student "report in" for the summer group-project census. Raw intake only —
// the fuzzy team-name/roster reconciliation happens in a separate one-shot pass,
// and booking tokens are granted downstream from the reconciled result (NOT here
// on submit). Supabase is authoritative; no Sheets mirror.

const RESPONSES = new Set(['finalized', 'not_finalized', 'no_project']);

function sheetIdFromPortalUrl(url) {
  const m = String(url ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

// The logged-in STUDENT (not a parent viewing on their behalf — this is the
// student's own report of their own project).
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

function toReport(r) {
  if (!r) return null;
  return {
    response: r.response,
    projectName: r.project_name,
    projectPlan: r.project_plan,
    teamMembers: r.team_members,
    timeline: r.timeline,
    preferredTime: r.preferred_time,
    updatedAt: r.updated_at,
  };
}

export async function GET() {
  const resolved = await resolveStudent();
  if (resolved.error) return resolved.error;
  const { sheetId } = resolved;

  const sb = getSupabaseClient();
  const { data: row, error } = await sb
    .from(PROJECT_REPORTS)
    .select('*')
    .eq('student_sheet_id', sheetId)
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ submitted: !!row, report: toReport(row) });
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

  const response = String(body?.response ?? '').trim();
  if (!RESPONSES.has(response)) {
    return Response.json({ error: 'Invalid response' }, { status: 400 });
  }

  const clean = (v) => String(v ?? '').trim();
  const payload = {
    student_sheet_id: sheetId,
    student_email: email,
    student_name: name,
    student_class: studentClass,
    response,
    updated_at: DateTime.utc().toISO(),
  };

  if (response === 'finalized') {
    const projectName = clean(body?.projectName);
    const projectPlan = clean(body?.projectPlan);
    const teamMembers = clean(body?.teamMembers);
    const timeline = clean(body?.timeline);
    const preferredTime = clean(body?.preferredTime);
    if (!projectName || !projectPlan || !teamMembers || !timeline) {
      return Response.json(
        { error: 'Please fill in your project name, plan, team members, and timeline.' },
        { status: 400 }
      );
    }
    Object.assign(payload, {
      project_name: projectName,
      project_plan: projectPlan,
      team_members: teamMembers,
      timeline,
      preferred_time: preferredTime || null,
    });
  } else {
    // A census-only response ('not_finalized' / 'no_project') — clear any prior
    // full-report fields (e.g. if a student edits down from a finalized report).
    Object.assign(payload, {
      project_name: null,
      project_plan: null,
      team_members: null,
      timeline: null,
      preferred_time: null,
    });
  }

  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from(PROJECT_REPORTS)
    .upsert(payload, { onConflict: 'student_sheet_id' })
    .select('*')
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ success: true, report: toReport(data) });
}
