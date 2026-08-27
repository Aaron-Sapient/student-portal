import { requireAdmin } from '@/lib/developerAuth';
import { getSupabaseClient } from '@/lib/supabase';
import { listDocumentsFor, studentIdFromSheetId } from '@/lib/studentFiles';
import { listWritingDocEntries } from '@/lib/writingDocs';

// GET /api/developer/studentFiles?sheetId=<id> → the same file payload the
// student's own /api/files returns, but for an ARBITRARY student, for the
// Students-tab hub (folder icon). Admin-gated (Aaron + Ryan). The incoming
// sheetId carries no authority on its own; it must resolve to a `students` row
// (the Supabase roster is the register now — no Master-sheet read here).
//
// Unlike the student's own /api/files, this ALSO folds in the student's in-app
// markdown essays (Common App / UC PIQs / Supplements), which open the
// full-screen /write editor in a new tab.
export async function GET(request) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  const sheetId = new URL(request.url).searchParams.get('sheetId');
  if (!sheetId) return Response.json({ error: 'Missing sheetId' }, { status: 400 });

  try {
    const student = await studentIdFromSheetId(sheetId);
    if (!student) return Response.json({ error: 'Unknown student' }, { status: 404 });

    const supabase = getSupabaseClient();
    const [docs, writingDocs] = await Promise.all([
      listDocumentsFor(gate.email, { studentId: student.id }),
      listWritingDocEntries(supabase, sheetId),
    ]);

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

    const files = [...essayFiles, ...docs].sort((a, b) => {
      if (!a.modified && !b.modified) return a.name.localeCompare(b.name);
      if (!a.modified) return 1;
      if (!b.modified) return -1;
      return b.modified.localeCompare(a.modified);
    });

    return Response.json({ studentName: student.name || '', files, counts: { portal: docs.length } });
  } catch (err) {
    console.error('studentFiles GET error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
