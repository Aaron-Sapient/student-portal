import { triggerReportGeneration } from '@/lib/generateReport';
import { requireAdmin } from '@/lib/developerAuth';

// Admin-only. This route takes an arbitrary { studentName, studentSheetId } and
// runs a paid model call plus Master-sheet writes against whatever it is handed,
// so a bare Clerk session is not a sufficient gate — any signed-in student or
// parent could have driven it against any student. It has no in-app callers (the
// check-in path calls triggerReportGeneration directly, and scripts/nas import the
// lib), so admin-gating costs nothing and closes the surface.
export async function POST(request) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  try {
    const { studentName, studentSheetId } = await request.json();
    if (!studentName || !studentSheetId) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }
    await triggerReportGeneration(studentName, studentSheetId);
    return Response.json({ success: true });
  } catch (err) {
    console.error('generateReport route error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}