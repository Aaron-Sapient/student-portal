/**
 * verifyProjectMeeting.mjs — pure-rule assertions + a live, self-cleaning smoke test of
 * the standing weekly "project meeting" track. Exercises the PURE gate (projectMeetingsCore)
 * across the temporal edges that scheduling bugs live in (Friday / week-boundary, 1/week
 * cap, cancelled-frees-the-week), then inserts a plan + booking for a SYNTHETIC sheet id
 * (no real student touched), reads them back through the same row shapes the app uses, and
 * deletes them. (Uses the Supabase client directly because lib/projectMeetings.js relies on
 * Next's extensionless import resolution — same approach as verifyOneoff.mjs.)
 *
 *   node scripts/verifyProjectMeeting.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import { createClient } from '@supabase/supabase-js';
import {
  ZONE,
  startOfSaturdayWeek,
  weekStartISO,
  canBookProjectOnDate,
  buildProjectCard,
} from '../lib/projectMeetingsCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
const getEnv = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
};
const sb = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const PLANS = 'project_meeting_plans';
const BOOKINGS = 'project_meeting_bookings';

let pass = 0, fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.log(`  ✗ ${m}`)));

const SHEET = 'TEST_PROJECT_VERIFY_DELETE_ME';
const plan = { id: 'X', student_sheet_id: SHEET, teacher: 'aaron', minutes: 30, label: 'Solo Research', active: true };

// ── Pure rules ───────────────────────────────────────────────────────────────
// Anchor "now" to a deterministic mid-week moment so the edges are reproducible.
const now = DateTime.fromISO('2026-07-01T12:00', { zone: ZONE }); // a Wednesday
const wkStart = startOfSaturdayWeek(now);                          // this Saturday
const nextWk = wkStart.plus({ weeks: 1 });
const d2 = now.plus({ days: 2 });

ok(canBookProjectOnDate(plan, d2, 'aaron', 30, [], now).ok, 'in-window day authorized (no bookings)');
ok(!canBookProjectOnDate(plan, d2, 'ryan', 30, [], now).ok, 'wrong teacher rejected');
ok(!canBookProjectOnDate(plan, d2, 'aaron', 15, [], now).ok, 'wrong length rejected');
ok(canBookProjectOnDate(plan, nextWk.plus({ days: 1 }), 'aaron', 30, [], now).ok, 'next-week day in horizon authorized');
ok(!canBookProjectOnDate(plan, now.plus({ days: 20 }), 'aaron', 30, [], now).ok, 'beyond two-week horizon rejected');
ok(!canBookProjectOnDate(plan, wkStart.minus({ days: 1 }), 'aaron', 30, [], now).ok, 'before this week (prior Friday) rejected');
ok(canBookProjectOnDate({ ...plan, active: false }, d2, 'aaron', 30, [], now).ok === false, 'inactive plan rejected');

// 1-per-Saturday-week cap.
const thisWeekBooked = [{ week_start: weekStartISO(now), status: 'active' }];
ok(!canBookProjectOnDate(plan, d2, 'aaron', 30, thisWeekBooked, now).ok, 'second booking same week rejected (1/week)');
ok(canBookProjectOnDate(plan, nextWk.plus({ days: 1 }), 'aaron', 30, thisWeekBooked, now).ok, 'next-week day still open when this week booked');
ok(canBookProjectOnDate(plan, d2, 'aaron', 30, [{ week_start: weekStartISO(now), status: 'cancelled' }], now).ok, 'cancelled booking frees the week');

// Friday / week-boundary edge — the exact "works Mon–Thu, breaks Friday" trap. On the
// last day of the week (when 24h notice pushes the earliest day into next week), the
// card must still offer a window, never strand the student with an empty calendar.
const fridayNow = wkStart.plus({ days: 6 }).set({ hour: 18 }); // last day of this Saturday-week
ok(fridayNow.weekday === 5, 'fixture lands on a Friday');
const cardFri = buildProjectCard(plan, [], fridayNow);
ok(cardFri.bookable && cardFri.window, 'Friday: still has a bookable window (rolls into next week)');
ok(cardFri.window.start >= fridayNow.plus({ days: 1 }).toISODate(), 'Friday window starts tomorrow or later');

// Card rolls forward as weeks fill.
const cardThisBooked = buildProjectCard(plan, thisWeekBooked, now);
ok(cardThisBooked.bookedThisWeek, 'card flags bookedThisWeek');
ok(cardThisBooked.bookable && cardThisBooked.window.start >= nextWk.toISODate(), 'window rolls to next week after this week booked');
const bothBooked = [{ week_start: weekStartISO(now), status: 'active' }, { week_start: nextWk.toISODate(), status: 'active' }];
ok(!buildProjectCard(plan, bothBooked, now).bookable, 'both weeks booked → not bookable');

// ── Live data path (synthetic sheet id) ──────────────────────────────────────
try {
  const { data: planRow, error: planErr } = await sb
    .from(PLANS)
    .insert({ student_sheet_id: SHEET, student_email: 'verify@example.com', teacher: 'aaron', minutes: 30, label: 'Solo Research', granted_by: 'verify' })
    .select()
    .single();
  ok(!planErr && planRow?.id, `plan insert accepts all columns (${planErr?.message || 'ok'})`);
  const planId = planRow?.id;

  const liveNow = DateTime.now().setZone(ZONE);
  const day = liveNow.plus({ days: 2 });
  const { data: bookRow, error: bookErr } = await sb
    .from(BOOKINGS)
    .insert({
      plan_id: planId,
      student_sheet_id: SHEET,
      calendar_event_id: 'EVT_PROJECT_VERIFY_123',
      teacher: 'aaron',
      meeting_date: day.toISODate(),
      week_start: startOfSaturdayWeek(day).toISODate(),
      minutes: 30,
    })
    .select()
    .single();
  ok(!bookErr && bookRow?.id, `booking insert accepts all columns (${bookErr?.message || 'ok'})`);

  // Read back the active booking and confirm the gate now blocks a second same-week book.
  const { data: active } = await sb
    .from(BOOKINGS)
    .select('week_start, status')
    .eq('plan_id', planId)
    .eq('status', 'active');
  ok((active || []).length === 1, `booking reads back as active (got ${(active || []).length})`);
  const livePlan = { ...plan, id: planId };
  ok(!canBookProjectOnDate(livePlan, day, 'aaron', 30, active, liveNow).ok, 'gate blocks a 2nd booking that week (live rows)');

  // DB-level cap (pmb_one_active_per_week): a 2nd ACTIVE booking for the same plan+week
  // is rejected with a unique violation (23505) even on a DIFFERENT day — closes the
  // concurrent check-then-insert race the app-level gate can't.
  const { error: dupErr } = await sb.from(BOOKINGS).insert({
    plan_id: planId,
    student_sheet_id: SHEET,
    calendar_event_id: 'EVT_PROJECT_VERIFY_DUP',
    teacher: 'aaron',
    meeting_date: day.plus({ days: 1 }).toISODate(),
    week_start: startOfSaturdayWeek(day).toISODate(),
    minutes: 30,
  });
  ok(dupErr?.code === '23505', `partial-unique index blocks a 2nd active booking same week (got ${dupErr?.code || 'no error'})`);

  // Cancel → week reopens.
  await sb.from(BOOKINGS).update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('calendar_event_id', 'EVT_PROJECT_VERIFY_123').eq('status', 'active');
  const { data: afterCancel } = await sb.from(BOOKINGS).select('week_start, status').eq('plan_id', planId).eq('status', 'active');
  ok((afterCancel || []).length === 0, 'cancel removes it from active');
  ok(canBookProjectOnDate(livePlan, day, 'aaron', 30, afterCancel, liveNow).ok, 'gate reopens the week after cancel');
} finally {
  // FK is ON DELETE CASCADE, but delete bookings first to be explicit.
  await sb.from(BOOKINGS).delete().eq('student_sheet_id', SHEET);
  await sb.from(PLANS).delete().eq('student_sheet_id', SHEET);
  const { data: leftPlans } = await sb.from(PLANS).select('id').eq('student_sheet_id', SHEET);
  const { data: leftBooks } = await sb.from(BOOKINGS).select('id').eq('student_sheet_id', SHEET);
  ok((leftPlans || []).length === 0 && (leftBooks || []).length === 0, 'cleanup deleted the synthetic rows');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
