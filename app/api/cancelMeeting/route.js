import { auth } from '@clerk/nextjs/server';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { DateTime } from 'luxon';
import { getInstructor } from '@/lib/instructors';
import { getSeniorByEmail, cancelBookingByEventId, cancelOneoffByEventId } from '@/lib/seniors';
import { cancelProjectBookingByEventId } from '@/lib/projectMeetings';
import { setBookingToken } from '@/lib/bookingTokens';
import { fetchOwnedEvent } from '@/lib/rescheduleTarget';
import {
  studentByEmail, standardBookingByEventId, cancelStandardBookingByEventId, reactivateStandardBooking,
} from '@/lib/bookings';

// Calendar-only. The Sheets scope and the Master `G:J` read left this route on
// 2026-08-27 (zero-Google sweep, Package C): identity comes from Supabase `students`,
// the booking record from Supabase `bookings`.
function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

async function sendCancellationEmail(instructor, studentName, meetingTitle, meetingStart) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const dateLabel = new Date(meetingStart).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles',
  });

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: instructor.cancelEmail,
    subject: `Meeting Cancelled: ${meetingTitle}`,
    text: `Hi ${instructor.displayName},\n\n${studentName} has cancelled their meeting scheduled for ${dateLabel} (Pacific Time).\n\nThey have been informed they can rebook at their convenience through the student portal.\n\nThis is an automated message from the student portal.`,
  });
}

const isGone = (err) => {
  const code = err?.code || err?.response?.status;
  return code === 404 || code === 410;
};

export async function POST(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { eventId, studentName, meetingTitle, meetingStart, duration, instructor: instructorSlug, isReschedule } = await request.json();
    if (!eventId) return Response.json({ error: 'Missing eventId' }, { status: 400 });

    const instructor = getInstructor(instructorSlug);

    const startTime = DateTime.fromISO(meetingStart).setZone('America/Los_Angeles');
    const now = DateTime.now().setZone('America/Los_Angeles');
    // Rescheduling still requires 24h notice (the cancel-half of a reschedule flow);
    // a standalone cancellation only requires 2h notice.
    const noticeHours = isReschedule ? 24 : 2;
    if (startTime < now.plus({ hours: noticeHours })) {
      return Response.json({
        error: isReschedule
          ? 'Meetings must be rescheduled at least 24 hours in advance.'
          : 'Meetings must be cancelled at least 2 hours in advance.',
      }, { status: 400 });
    }

    const authClient = getServiceAuth();
    const calendar = google.calendar({ version: 'v3', auth: authClient });

    // ── OWNERSHIP GATE ───────────────────────────────────────────────────────
    // Before this existed the route deleted whatever `eventId` the body named,
    // on the instructor's calendar, behind nothing but a bare Clerk session — and
    // then restored a booking token to the CALLER's row. Any signed-in student or
    // parent could delete someone else's meeting and be handed a free one for it.
    // Resolve the caller from the session (never from body.studentName, which
    // would let an attacker pass the victim's name straight through the title
    // fallback), then refuse anything that isn't theirs.
    //
    // Order of proof: the `bookings` row first (Postgres is the record — it answers
    // even when Calendar is down), then the event itself (portal provenance in
    // extendedProperties, then the title rule) for senior/project/hand-made events.
    // A roster miss degrades SAFELY: without a verified name only provenance can
    // establish ownership, so hand-made instructor events stop being self-cancellable
    // until the roster read recovers.
    let roster = null;
    try {
      roster = await studentByEmail(email);
    } catch (rosterErr) {
      console.error('cancelMeeting: roster read failed (ownership falls back to event provenance):', rosterErr?.message || rosterErr);
    }
    const callerName = roster?.name ? String(roster.name).trim() : null;

    // Guarded exactly like the roster read above, and for the same reason: three of
    // the four tracks (senior, project, hand-made) have NO row here, so an
    // unreadable `bookings` table — the 42P01 a not-yet-applied migration returns —
    // must read as "no standard record" and fall through to event provenance, not
    // 500 every cancel on every track.
    let record = null;
    try {
      record = await standardBookingByEventId(eventId);
    } catch (recordErr) {
      console.error('cancelMeeting: bookings read failed (treating as no standard record):', recordErr?.message || recordErr);
    }
    let owned = false;
    if (record) {
      owned = !!roster && record.student_sheet_id === roster.student_sheet_id;
    } else {
      owned = !!(await fetchOwnedEvent(calendar, instructor, eventId, email, callerName));
    }
    if (!owned) {
      return Response.json({ error: 'Meeting not found' }, { status: 404 });
    }

    // The RECORD is cancelled first, then the event. If the event is already gone
    // (Aaron deleted it by hand — the reconcile direction exists for exactly that),
    // that is fine: the row was the truth and now says cancelled. Any OTHER Calendar
    // failure re-activates the row so the two never disagree, and surfaces as a 500.
    // Same guard, one asymmetry that is deliberate: when the read above DID return a
    // row, a failure to cancel it is real news and still throws — nothing destructive
    // has run yet, so a 500 here leaves the event and the row agreeing. Only the
    // "there is no standard record" case (including an unreadable table) is swallowed.
    let cancelledRow = null;
    try {
      cancelledRow = await cancelStandardBookingByEventId(eventId);
    } catch (cancelErr) {
      if (record) throw cancelErr;
      console.error('cancelMeeting: bookings cancel failed with no readable record (treating as no standard record):', cancelErr?.message || cancelErr);
    }
    try {
      await calendar.events.delete({
        calendarId: instructor.calendarId,
        eventId,
      });
    } catch (delErr) {
      if (!isGone(delErr)) {
        if (cancelledRow) {
          try { await reactivateStandardBooking(cancelledRow.id); }
          catch (undoErr) { console.error(`cancelMeeting: could not re-activate booking ${cancelledRow.id} after Calendar delete failed:`, undoErr?.message || undoErr); }
        }
        throw delErr;
      }
      console.warn(`cancelMeeting: event ${eventId} already gone from Calendar; record ${cancelledRow?.id || '(none)'} cancelled.`);
    }

    // Seniors: return the consumed token to their check-in grant OR their one-off
    // track (both no-op for non-matching events). On a reschedule the follow-up
    // bookMeeting re-consumes whichever applied. Project meetings free their own
    // 1/week ledger row (no-op for non-project events).
    await cancelBookingByEventId(eventId);
    await cancelOneoffByEventId(eventId);
    const wasProject = await cancelProjectBookingByEventId(eventId);

    // The caller's own sheet id. The roster row is the first source (the SAME
    // session-resolved lookup the ownership gate used — no second read, no chance of
    // the gate and the token restore disagreeing about who this is), but the roster
    // read is guarded and can come back null while the cancel still succeeds through
    // event provenance. That path used to skip the token restore in silence: the
    // student lost the meeting AND the grant, with nothing said. The booking row
    // carries the same id and was verified against this caller, so fall back to it.
    const cancelSheetId = roster?.student_sheet_id || record?.student_sheet_id
      || cancelledRow?.student_sheet_id || null;

    // Token logic:
    //  - Seniors: NO token — the per-week cap is recounted from live calendar events,
    //    so deleting this event already frees the slot. Never write a column for them.
    //  - Reschedule (cancel half of a reschedule flow): leave token consumed; bookMeeting will not re-consume.
    //  - Real cancel + standard tracking: restore token to the meeting's original duration ('15min' / '30min')
    //    — from the RECORD when there is one; the client's `duration` only for legacy events with no row.
    //  - Real cancel + timestamp tracking (ART): clear the column so weekly check sees no booking.
    // null = no restore was owed (senior / project / a reschedule holding its token);
    // false = one WAS owed and did not happen, which the client is told about rather
    // than being handed a bare success.
    let tokenRestored = null;
    const senior = await getSeniorByEmail(email);
    const restoreOwed = !senior && !wasProject;
    if (!cancelSheetId && restoreOwed) {
      tokenRestored = false;
      console.error(`cancelMeeting: TOKEN NOT RESTORED for ${email} (${instructor.slug}) — the cancel succeeded but no student sheet id could be resolved (roster read failed and no bookings row matched); re-grant manually.`);
    }
    if (cancelSheetId && restoreOwed) {
      let newValue = null;
      if (instructor.tokenIsTimestamp) {
        if (!isReschedule) newValue = '';
      } else {
        const recordedLength = cancelledRow?.minutes ? `${cancelledRow.minutes}min` : null;
        newValue = isReschedule ? 'no' : (recordedLength || duration || '15min');
      }
      if (newValue !== null) {
        // Authoritative restore (Supabase booking_tokens; '' = ART clear →
        // delete the row). Best-effort AT THIS POINT ONLY: the event is already
        // deleted, so throwing here would skip the cancellation email and 500 a
        // cancel that half-happened — log loudly instead; an admin re-grant
        // recovers a lost token.
        try {
          await setBookingToken({ studentSheetId: cancelSheetId, slug: instructor.slug, value: newValue });
          tokenRestored = true;
        } catch (tokenErr) {
          tokenRestored = false;
          console.error(`cancelMeeting: TOKEN RESTORE FAILED for ${email} (${instructor.slug} → ${JSON.stringify(newValue)}) — re-grant manually:`, tokenErr?.message || tokenErr);
        }
      }
    }

    try {
      await sendCancellationEmail(instructor, callerName || studentName, meetingTitle, meetingStart);
    } catch (emailErr) {
      console.error('Failed to send cancellation email:', emailErr);
    }

    // tokenRestored is present ONLY when a restore was owed and did not land — a
    // silently-lost grant is the one failure a student cannot see for themselves.
    return Response.json({
      success: true,
      bookingId: cancelledRow?.id || null,
      ...(tokenRestored === false ? { tokenRestored: false } : {}),
    });

  } catch (err) {
    console.error('cancelMeeting error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
