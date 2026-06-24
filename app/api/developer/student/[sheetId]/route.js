import { DateTime } from 'luxon';
import { requireAdmin } from '@/lib/developerAuth';
import { getGoogleSheetsClient } from '@/lib/google';
import { getSupabaseClient, STUDENT_PROFILES, MEETINGS_TABLE } from '@/lib/supabase';
import { listRoster } from '../../studentScores/shared';
import { hasRecentGrades, TRANSCRIPT_GRADE_RANGE } from '@/lib/gradeData';

const ZONE = 'America/Los_Angeles';

// GET /api/developer/student/<sheetId> → the per-student hub aggregate for the
// Students tab: identity (name/class year/intended major), the transcript grid,
// and the read-only meeting agenda. Admin-gated; the sheetId is validated against
// the Master roster before any read. Scores + check-in history and the file list
// are fetched separately by the hub (the existing studentScores/[sheetId] and
// studentFiles endpoints), so this call stays a small, quota-aware fan-out.
//
// Agenda comes from the Supabase `meetings` mirror (Aaron's choice) — read-only,
// degrades to [] until the reconcile cron backfills it. This route NEVER writes
// to the 📆 Meetings sheet, so the live student "This week with …" card is safe.

// Intended major for one student from the profile mirror; null if absent/empty.
async function readMajor(sheetId) {
  try {
    const sb = getSupabaseClient();
    const { data, error } = await sb
      .from(STUDENT_PROFILES)
      .select('major')
      .eq('student_sheet_id', sheetId)
      .maybeSingle();
    if (error) return null;
    const m = String(data?.major ?? '').trim();
    return m || null;
  } catch {
    return null;
  }
}

// Read-only agenda rows (newest first) from the Supabase meetings mirror.
async function readAgenda(sheetId) {
  try {
    const sb = getSupabaseClient();
    const { data, error } = await sb
      .from(MEETINGS_TABLE)
      .select('meeting_date, teacher, project, agenda, homework, hw_status, pct')
      .eq('student_sheet_id', sheetId)
      .order('meeting_date', { ascending: false });
    if (error) return [];
    return (data || []).map((r) => ({
      date: r.meeting_date || null,
      teacher: r.teacher || null,
      project: r.project || null,
      agenda: r.agenda || null,
      homework: r.homework || null,
      hwStatus: r.hw_status || null,
      pct: r.pct ?? null,
    }));
  } catch {
    return [];
  }
}

export async function GET(request, { params }) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  const { sheetId } = await params;
  if (!sheetId) return Response.json({ error: 'Missing sheetId' }, { status: 400 });

  try {
    const sheets = getGoogleSheetsClient('developer-dashboard');
    const roster = await listRoster(sheets);
    const me = roster.find((s) => s.sheetId === sheetId);
    if (!me) return Response.json({ error: 'Unknown student' }, { status: 404 });

    const [major, agenda, transcriptValues] = await Promise.all([
      readMajor(sheetId),
      readAgenda(sheetId),
      sheets.spreadsheets.values
        .get({ spreadsheetId: sheetId, range: TRANSCRIPT_GRADE_RANGE })
        .then((r) => r.data.values || [])
        .catch(() => []), // transcript tab may not exist yet
    ]);

    const nowLA = DateTime.now().setZone(ZONE);
    // hasRecentGrades returns { enough, ... }; we only surface the boolean.
    const recentGrades = transcriptValues.length
      ? !!hasRecentGrades(transcriptValues, me.grade, nowLA)?.enough
      : false;

    return Response.json({
      sheetId,
      name: me.name,
      grade: me.grade,
      classYear: me.classYear,
      major,
      transcript: { values: transcriptValues, recentGrades },
      agenda,
    });
  } catch (err) {
    console.error('student hub GET error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
