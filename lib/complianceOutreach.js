// Shared snapshot + the single "should we nudge?" predicate for the meeting-
// compliance outreach crons. SERVER-ONLY (service-role Supabase + the senior libs).
//
// One code path feeds BOTH crons so they can never diverge:
//   • app/api/cron/complianceDigest  — Phase 0, internal digest. Renders every field
//     below incl. `phase1WouldFire`, so the digest is literally the nudge's dry-run.
//   • app/api/cron/essayNudge        — Phase 1, the autonomous student/parent nudge.
//
// The meeting signal is a VERIFIED conjunction, not a single source:
//   authoritative ledger = senior_bookings (written synchronously at booking time),
//   secondary suppressor = meeting_cap_summary (a calendar mirror that LAGS the
//   ledger — verified: Maha's 7/14 bookings were absent from a "fresh" cap row).
// We fire only when BOTH say "no meeting": the ledger catches recent portal bookings
// the cap misses, and the cap catches off-portal/manual holds the ledger misses.
// Neither is complete alone. See the plan: this-roleplay-revealed-a-jaunty-quokka.md.

import { DateTime } from 'luxon';
import {
  getActiveSeniors,
  loadSeniorBookingState,
  seniorBookingPlan,
  startOfSaturdayWeek,
  ZONE,
} from './seniors';
import {
  getSupabaseClient,
  SENIOR_BOOKINGS,
  MEETING_CAP_SUMMARY,
  PROJECT_MEETING_PLANS,
  OUTREACH_LOG,
  OUTREACH_SUPPRESSIONS,
} from './supabase';

// The permanent known-good senior fixture (vip/ryan) — never a real recipient.
const TEST_SHEET_IDS = new Set(['1UW-RSqv30c_BUdv9nfm48YVVs7L-UmWKsYn_jXhYt6w']);

// meeting_cap_summary stores timestamptz at LA-midnight → the LA calendar date, or null.
function capDate(v) {
  if (!v) return null;
  const dt = DateTime.fromISO(String(v), { zone: 'utc' }).setZone(ZONE);
  return dt.isValid ? dt.toISODate() : null;
}

// One row per active senior with everything the digest shows and the nudge decides on.
export async function loadOutreachSnapshot(now = DateTime.now().setZone(ZONE)) {
  const seniors = (await getActiveSeniors()).filter((s) => !TEST_SHEET_IDS.has(s.student_sheet_id));
  const ids = seniors.map((s) => s.student_sheet_id);
  const thisWeekStart = startOfSaturdayWeek(now).toISODate();
  const todayISO = now.toISODate();
  const sb = getSupabaseClient();

  // Batched, roster-independent signals (all keyed on student_sheet_id).
  const [bookRes, capRes, planRes] = await Promise.all([
    // Authoritative essay bookings for THIS week or later — queried directly (not via
    // the active-grant-scoped state.bookings), so a meeting booked under a carried
    // grant still counts as coverage.
    sb.from(SENIOR_BOOKINGS)
      .select('student_sheet_id, meeting_date, teacher, minutes')
      .in('student_sheet_id', ids).eq('status', 'active').gte('meeting_date', thisWeekStart),
    sb.from(MEETING_CAP_SUMMARY).select('*').in('student_sheet_id', ids),
    // Any ACTIVE standing project plan ⇒ NOT essay-only (their Aaron meetings live on
    // a separate ledger; we don't auto-nudge them — they're a human-judgment case).
    sb.from(PROJECT_MEETING_PLANS).select('student_sheet_id').in('student_sheet_id', ids).eq('active', true),
  ]);

  const bookedBySheet = new Map();
  for (const r of bookRes.data || []) {
    if (!bookedBySheet.has(r.student_sheet_id)) bookedBySheet.set(r.student_sheet_id, []);
    bookedBySheet.get(r.student_sheet_id).push(r);
  }
  const capBySheet = new Map((capRes.data || []).map((r) => [r.student_sheet_id, r]));
  const projectPlanSheets = new Set((planRes.data || []).map((r) => r.student_sheet_id));

  const rows = await Promise.all(seniors.map(async (senior) => {
    const sheetId = senior.student_sheet_id;
    const state = await loadSeniorBookingState(senior);
    const plan = seniorBookingPlan(senior, now, state);

    // "Do you owe THIS Saturday-week's check-in?" — the grant whose week_start is this
    // week (a carried grant from last week reads false, correctly).
    const checkedInThisWeek = !!plan.hasGrant && !!plan.grantWindow && plan.grantWindow.start === plan.thisWeek.start;
    const essayOnly = !projectPlanSheets.has(sheetId);
    const bookedThisWeekAhead = (bookedBySheet.get(sheetId) || []).length > 0;

    const cap = capBySheet.get(sheetId) || null;
    const lastR = capDate(cap?.last_ryan_meeting);
    const lastA = capDate(cap?.last_aaron_meeting);
    const upR = capDate(cap?.upcoming_ryan_meeting);
    const upA = capDate(cap?.upcoming_aaron_meeting);
    const capHasMeeting =
      (!!lastR && lastR >= thisWeekStart) || (!!lastA && lastA >= thisWeekStart) ||
      (!!upR && upR >= todayISO) || (!!upA && upA >= todayISO);
    const lastMeeting = [lastR, lastA].filter(Boolean).sort().pop() || null;
    const nextMeeting = [upR, upA].filter(Boolean).sort()[0] || null;
    const darkWeeks = lastMeeting
      ? Math.floor(now.startOf('day').diff(DateTime.fromISO(lastMeeting, { zone: ZONE }), 'weeks').weeks)
      : null;

    // The conjunction gate. Both the ledger AND the cap must say "no meeting".
    const phase1WouldFire =
      essayOnly && checkedInThisWeek && plan.remaining > 0 &&
      !bookedThisWeekAhead && !capHasMeeting;

    // Data-health: the two coverage sources disagree (cap-lag OR off-ledger hold).
    const ledgerCapDisagree = bookedThisWeekAhead !== capHasMeeting;

    return {
      sheetId, name: senior.student_name, email: senior.student_email,
      package: senior.package, primary: senior.primary_teacher,
      essayOnly, checkedInThisWeek, remaining: plan.remaining,
      bookedThisWeekAhead, capHasMeeting, ledgerCapDisagree,
      lastMeeting, nextMeeting, darkWeeks,
      capMissing: !cap,
      phase1WouldFire,
    };
  }));

  return { now, thisWeekStart, rows };
}

// Is the nudge silenced for this student right now? (vacation / phase gap / paused)
export async function isSuppressed(sheetId, now = DateTime.now().setZone(ZONE)) {
  const sb = getSupabaseClient();
  const { data } = await sb.from(OUTREACH_SUPPRESSIONS)
    .select('until').eq('student_sheet_id', sheetId).maybeSingle();
  if (!data) return false;
  if (!data.until) return true;         // indefinite
  return data.until >= now.toISODate(); // still within the window
}
