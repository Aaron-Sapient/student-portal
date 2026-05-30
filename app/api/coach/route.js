import { auth } from '@clerk/nextjs/server';
import { getCoachMessage } from '@/lib/coachMessages';

// Returns the current Claude Coach note for the logged-in student, or null.
// Swap getCoachMessage's source for the cron-written Sheet/store later — the
// response shape stays the same.
export async function GET() {
  const { userId, sessionClaims } = await auth();
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const email = sessionClaims?.email ?? sessionClaims?.primary_email_address ?? null;
  return Response.json({ coach: getCoachMessage(email) });
}
