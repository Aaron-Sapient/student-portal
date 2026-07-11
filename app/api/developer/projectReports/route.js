import { requireAdmin } from '@/lib/developerAuth';
import { getGoogleSheetsClient } from '@/lib/google';
import { getSupabaseClient, PROJECT_REPORTS } from '@/lib/supabase';
import { listRoster } from '../studentScores/shared';

// GET /api/developer/projectReports → the summer group-project census
// (app/(portal)/project-report/), grouped by student, cross-referenced against
// the full roster so Ryan can see who HASN'T reported in yet, not just who has.
// Raw intake only — team-name reconciliation is a separate offline pass, not
// this route. Admin-gated so it works on the Ryan-facing /dev surface.

function toProject(r) {
  return {
    index: r.project_index,
    response: r.response,
    projectName: r.project_name || '',
    projectPlan: r.project_plan || '',
    teamMembers: r.team_members || '',
    timeline: r.timeline || '',
    preferredTime: r.preferred_time || '',
    updatedAt: r.updated_at,
  };
}

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  try {
    const sheets = getGoogleSheetsClient('developer-dashboard');
    const sb = getSupabaseClient();
    const [roster, { data: rows, error }] = await Promise.all([
      listRoster(sheets),
      sb.from(PROJECT_REPORTS).select('*').order('project_index', { ascending: true }),
    ]);
    if (error) throw new Error(error.message);

    const rosterById = new Map(roster.map((s) => [s.sheetId, s]));
    const bySheetId = new Map();
    for (const r of rows || []) {
      const list = bySheetId.get(r.student_sheet_id) || [];
      list.push(r);
      bySheetId.set(r.student_sheet_id, list);
    }

    const reported = [];
    for (const [sheetId, studentRows] of bySheetId) {
      const rosterInfo = rosterById.get(sheetId);
      const first = studentRows[0];
      const isNoProject = studentRows.length === 1 && first.response === 'no_project';
      const projects = isNoProject ? [] : studentRows.map(toProject);
      reported.push({
        sheetId,
        name: rosterInfo?.name || first.student_name || 'Unknown',
        email: first.student_email || '',
        grade: rosterInfo?.grade || first.student_class || '',
        status: isNoProject ? 'no_project' : 'in_project',
        needsRoster: projects.some((p) => p.response === 'not_finalized'),
        updatedAt: studentRows.reduce(
          (max, r) => (r.updated_at > max ? r.updated_at : max),
          first.updated_at
        ),
        projects,
      });
    }
    reported.sort((a, b) => a.name.localeCompare(b.name));

    const notReported = roster
      .filter((s) => !bySheetId.has(s.sheetId))
      .map((s) => ({ sheetId: s.sheetId, name: s.name, grade: s.grade }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return Response.json({ reported, notReported });
  } catch (err) {
    console.error('projectReports GET error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
