import { auth } from '@clerk/nextjs/server';
import { DateTime } from 'luxon';
import { getInstructor } from '@/lib/instructors';
import { getBookingToken } from '@/lib/bookingTokens';
import { getStudentByEmail, getStudentProfile, studentDisplay } from '@/lib/identity';
import { getSupabaseClient, MEETING_CAP_SUMMARY } from '@/lib/supabase';
import { getSeniorByEmail, loadSeniorBookingState, seniorBookingPlan } from '@/lib/seniors';
import { loadProjectPlanForBooking, loadProjectBookingsForPlan, buildProjectCard } from '@/lib/projectMeetings';

// Zero Google in this route (ruling 2026-08-27): identity + ART flag come from
// Supabase `students`, the name from `student_profiles`, tokens from
// booking_tokens (cutover 2026-08-19), the Ryan monthly cap from
// meeting_cap_summary. The old Master A:BD / 🔎 Overview!B2 / ✅ Check-Ins reads
// are gone — a student whose sheet lacks the Overview tab could not book at all
// (Ryan Koo, 2026-08-26), on EVERY track, because those reads ran before the
// project-track branch and the branch consumed their result.
const NON_BOOKABLE_VALUE = { ryan: 'written', aaron: 'email' };

function mostRecentSaturdayLA() {
  const now = DateTime.now().setZone('America/Los_Angeles');
  let sat = now.set({ weekday: 6 });
  if (now.weekday < 6) sat = sat.minus({ weeks: 1 });
  return sat.startOf('day');
}

// Ryan's monthly meeting cap. One row per student, kept fresh by the reconcile
// cron (scripts/backfillCheckinSummary.cjs) and mirrored on cap lifts by
// admin/grantBooking. Returns { used, allowed } or null. Fails OPEN (null) on a
// read error or a missing row: a cap read must never block a valid token.
async function loadRyanCap(studentSheetId) {
  try {
    const { data, error } = await getSupabaseClient()
      .from(MEETING_CAP_SUMMARY)
      .select('meetings_used, meetings_allowed')
      .eq('student_sheet_id', studentSheetId)
      .limit(1);
    if (error) throw new Error(error.message);
    const row = data?.[0];
    if (!row || row.meetings_allowed === null || row.meetings_allowed === undefined) return null;
    const allowed = Number(row.meetings_allowed);
    if (!Number.isFinite(allowed)) return null;
    return { used: Number(row.meetings_used) || 0, allowed };
  } catch (e) {
    console.error('validateBooking: cap read failed (not enforcing):', e?.message || e);
    return null;
  }
}

export async function GET(request) {
  const { sessionClaims } = await auth();
  const email = sessionClaims?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const instructor = getInstructor(searchParams.get('instructor'));

  try {
    // Identity FIRST, from Postgres, then branch — every track below (project,
    // senior, ART, standard) needs the sheet id and the name, so the resolution
    // order is unchanged; only the source moved.
    const student = await getStudentByEmail(email);
    if (!student) return Response.json({ error: 'Student not found' }, { status: 404 });

    const studentSheetId = student.student_sheet_id;
    if (!studentSheetId) return Response.json({ error: 'No student sheet found' }, { status: 404 });

    // Name from the 🔎 Overview mirror, degraded to students.name on a missing
    // profile row — never fatal, never 404.
    const profile = await getStudentProfile(studentSheetId);
    const { studentName } = studentDisplay(student, profile);

    // Project-meeting path (deep-linked ?m=project:<id>) — a standing weekly track,
    // authorized PURELY by the plan (no check-in / senior gate). Resolved FIRST so a
    // senior's project booking with their essay teacher is never mistaken for an essay
    // meeting (same teacher, same length — the disambiguation IS the path).
    const mKey = searchParams.get('m') || '';
    if (mKey.startsWith('project:')) {
      const planId = mKey.slice('project:'.length);
      const plan = await loadProjectPlanForBooking(email, planId);
      if (!plan || plan.teacher !== instructor.slug) {
        return Response.json({
          allowed: false,
          project: true,
          reason: 'That project meeting isn’t available to book right now.',
        });
      }
      const now = DateTime.now().setZone('America/Los_Angeles');
      const bookings = await loadProjectBookingsForPlan(planId, now);
      const card = buildProjectCard(plan, bookings, now);
      if (!card.bookable) {
        return Response.json({
          allowed: false,
          project: true,
          reason: card.bookedThisWeek
            ? 'You’ve already booked this week’s project meeting.'
            : 'No open project-meeting days right now — check back next week.',
        });
      }
      return Response.json({
        allowed: true,
        project: true,
        studentName,
        instructor: instructor.slug,
        durations: card.durations, // single fixed length
        kind: 'project',
        label: card.label,
        eligibleWindow: card.window,
        grantWindow: card.window,
        goldWeek: false,
      });
    }

    // Senior path: an active check-in grant is the prerequisite. The shared
    // booking plan (same one the meetings card + calendar read) tells us whether
    // THIS teacher is actually bookable on this check-in, so a direct visit to a
    // teacher who isn't reachable (e.g. the cross-meeting isn't part of this
    // grant, or it's already booked) gets a clear message instead of an empty
    // calendar. Per-date gates still run in getAvailableSlots/bookMeeting.
    const senior = await getSeniorByEmail(email);
    if (senior) {
      const state = await loadSeniorBookingState(senior);
      const plan = seniorBookingPlan(senior, DateTime.now().setZone('America/Los_Angeles'), state);

      // The /meetings page is the meeting-type router: each card deep-links its
      // specific meeting via ?m=<key>, and we commit to exactly that one — never a
      // merge of every reachable type. Keys: 'oneoff:<id>' for an admin one-off,
      // else the single weekly meeting for this teacher ('cross'/'primary'/absent,
      // since primary ≠ secondary there's at most one). A one-off is an additive
      // track bookable even with no weekly grant, so resolve it BEFORE the grant gate.
      const mine = plan.meetings.find((mm) => mm.slug === instructor.slug);
      const oneoffs = (plan.oneoffs || []).filter((o) => o.slug === instructor.slug);
      let option = null;
      if (mKey.startsWith('oneoff:')) {
        const id = mKey.slice('oneoff:'.length);
        option = oneoffs.find((o) => String(o.id) === id) || null;
      } else if (mKey === 'cross' || mKey === 'primary') {
        option = mine || null;
      }
      // Fallback for a bare URL or a stale key: prefer the weekly meeting, else the
      // first active one-off for this teacher.
      if (!option) option = mine || oneoffs[0] || null;

      if (!option) {
        if (!state.grant && oneoffs.length === 0) {
          return Response.json({
            allowed: false,
            senior: true,
            reason: "Complete this week's check-in to unlock booking.",
          });
        }
        const isTeacher = instructor.slug === plan.primarySlug || instructor.slug === plan.secondarySlug;
        return Response.json({
          allowed: false,
          senior: true,
          reason: isTeacher
            ? `No ${instructor.displayName} meeting is available on this check-in right now.`
            : 'That isn’t one of your assigned teachers.',
        });
      }

      return Response.json({
        allowed: true,
        senior: true,
        studentName,
        instructor: instructor.slug,
        // The committed meeting's OWN context — no cross-type bleed.
        durations: option.durations,
        kind: option.kind, // 'cross' | 'primary' | 'oneoff'
        eligibleWindow: option.window,
        grantWindow: plan.grantWindow,
        phase: plan.phase,
        goldWeek: option.kind === 'cross', // only the cross owns the gold phase week
        oneoffId: option.id || null,
      });
    }

    // ART path: requires students.art_eligible (a real boolean — no 'TRUE' string
    // any more), and the art token either empty or older than this week's Saturday.
    if (instructor.slug === 'art') {
      const isART = student.art_eligible === true;
      if (!isART) {
        return Response.json({ allowed: false, reason: 'Not part of the Advanced Research Team.' });
      }
      const bdValue = await getBookingToken(studentSheetId, 'art');
      if (bdValue) {
        const bookingDate = DateTime.fromISO(String(bdValue)).setZone('America/Los_Angeles');
        if (bookingDate.isValid && bookingDate >= mostRecentSaturdayLA()) {
          return Response.json({
            allowed: false,
            reason: 'You\'ve already booked your ART meeting this week.',
          });
        }
      }
      return Response.json({ allowed: true, decision: '15min', studentName });
    }

    // Standard path (Ryan / Aaron): decision string drives gating. ('pending'
    // is no longer a reachable value — the check-in evaluator grants directly.)
    const decision = (await getBookingToken(studentSheetId, instructor.slug)) || null;
    const nonBookable = NON_BOOKABLE_VALUE[instructor.slug];

    // Allowlist: ONLY '15min'/'30min' book. nonBookable ('written'/'email')
    // keeps its specific message; anything else — 'no', empty, or residue from
    // a retired vocabulary — denies generically rather than falling through.
    if (decision !== '15min' && decision !== '30min') {
      return Response.json({
        allowed: false,
        reason: decision === nonBookable
          ? nonBookable
          : 'No booking authorization found. Please complete your weekly check-in first.',
      });
    }

    // Meeting cap (Ryan only) — meeting_cap_summary, keyed by sheet id (the old
    // ✅ Check-Ins lookup joined on the Overview name, which is exactly the field
    // that diverges from the roster for several live students).
    if (instructor.slug === 'ryan') {
      const cap = await loadRyanCap(studentSheetId);
      if (cap && cap.used >= cap.allowed) {
        return Response.json({
          allowed: false,
          reason: `You've used all ${cap.allowed} of your allowed meetings this month.`,
        });
      }
    }

    return Response.json({
      allowed: true,
      decision,
      studentName,
    });

  } catch (err) {
    console.error('validateBooking error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
