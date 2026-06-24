import { requireAdmin } from '@/lib/developerAuth';
import { getGoogleSheetsClient } from '@/lib/google';
import { getSupabaseClient } from '@/lib/supabase';
import { listStudentFiles } from '@/lib/studentFiles';
import { listWritingDocEntries } from '@/lib/writingDocs';
import { listRoster } from '../studentScores/shared';

// GET /api/developer/studentFiles?sheetId=<id> → the same file payload the
// student's own /api/files returns, but for an ARBITRARY student, for the
// Students-tab hub (folder icon). Admin-gated (Aaron + Ryan). The incoming
// sheetId carries no authority on its own, so it's validated against the Master
// roster before any read — an admin can only list files for a real student.
//
// Unlike the student's own /api/files, this ALSO folds in the student's in-app
// markdown essays (Common App / UC PIQs / Supplements). Those live in Supabase,
// not Drive, so listStudentFiles never saw them — which is why a student's
// essays were missing from the developer Files view. They open the full-screen
// /write editor in a new tab.
export async function GET(request) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  const sheetId = new URL(request.url).searchParams.get('sheetId');
  if (!sheetId) return Response.json({ error: 'Missing sheetId' }, { status: 400 });

  try {
    const sheets = getGoogleSheetsClient('developer-dashboard');
    const roster = await listRoster(sheets);
    if (!roster.some((s) => s.sheetId === sheetId)) {
      return Response.json({ error: 'Unknown student' }, { status: 404 });
    }

    // Supabase backs the in-app essays; if it isn't configured the Files list
    // still serves the Drive/local files (essays just don't appear).
    let supabase = null;
    try {
      supabase = getSupabaseClient();
    } catch {
      /* not configured — degrade to Drive/local only */
    }

    const [payload, writingDocs] = await Promise.all([
      listStudentFiles(sheets, sheetId),
      supabase ? listWritingDocEntries(supabase, sheetId) : Promise.resolve([]),
    ]);

    // Map essays to the same file-row shape the UI renders, then merge them in
    // and re-sort newest-first (entries without a date sink to the bottom) —
    // identical ordering to listStudentFiles.
    const essayFiles = writingDocs.map((d) => ({
      id: `md:${d.docId}`,
      source: 'writing',
      isReport: false,
      isEditable: false,
      name: d.label,
      filename: d.label,
      kind: 'essay',
      ext: '',
      modified: d.modified,
      size: null,
      tabCount: d.tabCount,
      openUrl: `/write/${d.docId}`,
    }));

    const files = [...essayFiles, ...(payload.files || [])].sort((a, b) => {
      if (!a.modified && !b.modified) return a.name.localeCompare(b.name);
      if (!a.modified) return 1;
      if (!b.modified) return -1;
      return b.modified.localeCompare(a.modified);
    });

    return Response.json({ ...payload, files });
  } catch (err) {
    console.error('studentFiles GET error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
