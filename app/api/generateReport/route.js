import { triggerReportGeneration } from '@/lib/generateReport';

export async function POST(request) {
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