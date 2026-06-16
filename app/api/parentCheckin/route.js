import { processParentCheckin } from '@/lib/parentCheckinCore';

// Public parent check-in endpoint (no auth — see proxy.js isPublicRoute).
// Trusts the submitted email by design: parents without portal credentials can
// still reach us, and unmatched emails are flagged for manual review in the
// support email rather than rejected. The authenticated portal version lives
// at /api/parent/checkin and uses the verified session email instead.
export async function POST(request) {
  try {
    const { parentEmail, concern } = await request.json();
    if (!parentEmail || !concern) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }
    const result = await processParentCheckin({ parentEmail, concern });
    return Response.json(result);
  } catch (err) {
    console.error('parentCheckin error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
