import { auth } from '@clerk/nextjs/server';
import { clearCheckin } from '@/lib/identity';

// Un-check the signed-in student for the week: clears their Ryan check-in stamp so
// the portal stops saying "you're checked in" and lets them submit again.
//
// PORTED, NOT DELETED (2026-09-02). This route has zero references anywhere in the
// tree — no fetch, no import — and the obvious move was to delete it. It is kept
// because _notes/cutover-field-map.md flags exactly this as an open design
// question: "the clear/reset semantics (resetFormStatus blanks AY) need an explicit
// model — a derived MAX won't 'un-check' the way blanking AY does. Resolve before
// cutting the check-in gate." Deleting the only implementation of the un-check
// would have closed that question by making it unaskable.
//
// The answer the cutover happens to give: last_ryan_checkin stayed a STORED column
// rather than becoming a MAX() over `checkins`, so blanking still works and the
// port is one keyed update. Was: read Master J:J for the row, blank AY<row>.
export async function POST() {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const cleared = await clearCheckin(email, 'ryan');
    if (!cleared) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json({ success: true });
  } catch (err) {
    console.error('resetFormStatus error:', err);
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
}
