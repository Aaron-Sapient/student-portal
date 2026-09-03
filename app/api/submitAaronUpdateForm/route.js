import { auth } from '@clerk/nextjs/server';
import { resolveCheckinStudent } from '@/lib/checkinIdentity';
import { DateTime } from 'luxon';
import { listBlocksForBooking, isDateBlocked } from '@/lib/blocks';
import { setBookingToken } from '@/lib/bookingTokens';
import { stampCheckin } from '@/lib/identity';
import { recordCheckin, setCheckinOutcome } from '@/lib/checkinRecords';


export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const {
      taskUpdates,         // [{ task, status }]
      upcomingDeadlines,
      questionsCategory,
      questionsText,
      responsePreference,
    } = body;

    // Identity comes from the SESSION, never the body — see lib/checkinIdentity.js.
    // body.studentRowIndex / .studentName are deliberately no longer read.
    const target = await resolveCheckinStudent();
    if (target.error) return target.error;
    // Overview!B2 verbatim — see the ⚠ note in lib/checkinIdentity.js.
    // No `sheets`: the Aaron track writes no spreadsheet at all now (its check-in
    // carries no grades, so it never touched the 🎓 Transcript grid).
    const { studentSheetId, studentName } = target;

    const now = new Date().toISOString();

    // ── 1. Stamp Aaron's check-in on the roster row ──────────────────────────
    // Was Master `BA${rowIndex}`. A keyed update on `students`, so no scan position
    // can go stale and stamp another student's row.
    await stampCheckin(studentSheetId, 'aaron', now);

    // ── 2. Build concatenated task-updates string ────────────────────────────
    const taskUpdatesString = (taskUpdates || [])
      .map(({ task, status }) => `${task}: ${status}`)
      .join('; ');

    // ── 3. Record the check-in ───────────────────────────────────────────────
    // Was an append to MASTER `A_CheckinForm!A:J`. The aaron payload keys differ
    // from ryan's because the two form tabs always differed — see the contract note
    // in lib/checkinRecords.js; unifying them would orphan one era's history.
    // `agenda` stays null here and is filled by bookMeeting, as col H was.
    const checkinId = await recordCheckin({
      studentSheetId,
      instructor: 'aaron',
      submittedAt: now,
      payload: {
        task_updates: taskUpdatesString || null,
        upcoming_deadlines: upcomingDeadlines || null,
        concern_category: questionsCategory || null,
        concern_text: questionsText || null,
        response_preference: responsePreference || null,
        agenda: null,
        routing_reason: null,
      },
    });

    // ── 4. Routing: honor the student's explicit choice exactly.
    // Aaron's flow is deterministic — no Claude, no judgment, no escalation.
    // The only override is a real calendar constraint (Aaron blocked today).
    const PREFERENCE_TO_DECISION = {
      '15min': '15min',
      '30min': '30min',
      'Ready to finalize over email': 'email',
    };

    let decision = PREFERENCE_TO_DECISION[responsePreference] || '15min';
    let reason = `Student selected ${responsePreference || '15min (default)'}.`;

    const today = DateTime.now().setZone('America/Los_Angeles').toFormat('yyyy-LL-dd');
    const blocks = await listBlocksForBooking();
    if (isDateBlocked(blocks, 'aaron', today)) {
      decision = 'email';
      reason = 'Aaron is unavailable today — finalize over email this week.';
    }

    // ── 5. Write the booking decision (authoritative: Supabase booking_tokens) ──
    // The Master BB cell is deliberately NOT written anymore — the booking
    // outcome lives in the database. The sheetId comes straight from the resolved
    // identity now; the col-G read that existed only because this route knew a row
    // index and not an id is gone. A failed write gets the same honest, retryable
    // contract as the senior grant path — never a bare "Server error" over a
    // check-in that half-happened.
    try {
      await setBookingToken({ studentSheetId, slug: 'aaron', value: decision });
    } catch (tokenErr) {
      console.error('submitAaronUpdateForm: booking-decision write failed:', tokenErr);
      return Response.json({ error: 'Check-in saved, but unlocking booking failed. Please retry.' }, { status: 500 });
    }

    // ── 6. Stamp the outcome on THIS check-in ────────────────────────────────
    // Was: re-read the whole A_CheckinForm tab, walk it for the LAST row whose
    // col B matched studentName, write cols I/J of that row. Same two failure modes
    // as the Ryan track — a name mismatch wrote the decision nowhere behind the
    // `lastMatchIndex > -1` guard, and same-named students raced for "last row".
    await setCheckinOutcome(checkinId, { decision, reason, existingPayload: null });

    return Response.json({ success: true, decision, reason });

  } catch (err) {
    console.error('submitAaronUpdateForm error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
