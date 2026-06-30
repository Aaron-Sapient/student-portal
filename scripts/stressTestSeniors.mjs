/**
 * stressTestSeniors.mjs — exhaustively exercise the deterministic senior booking
 * rules (lib/seniorsCore.js) and cross-check the live `seniors` roster. Read-only.
 *
 *   node scripts/stressTestSeniors.mjs          # pure-logic + roster assertions
 *   node scripts/stressTestSeniors.mjs --live   # also read each teacher's calendar (current week)
 *
 * Pure functions are imported straight from lib/seniorsCore.js (luxon-only, so it
 * loads in plain Node). The roster comes from Supabase; --live also reads Google
 * Calendar to print this week's booked/remaining per senior.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import { createClient } from '@supabase/supabase-js';
import {
  PACKAGE_RULES,
  weekOfMonth,
  assignedPlanForWeek,
  grantWindow,
  meetingInWindow,
  grantRemaining,
  canBookOnDate,
  grantCarriesCrossMeeting,
  buildSeniorBookingPlan,
  startOfSaturdayWeek,
  bookedForWeekOf,
} from '../lib/seniorsCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZONE = 'America/Los_Angeles';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

const bk = (teacher, minutes, meeting_date) => ({ teacher, minutes, meeting_date });

function pureLogicTests() {
  const D = (d) => DateTime.fromObject({ year: 2026, month: 6, day: d }, { zone: ZONE });

  console.log('\n── Week-of-month (Saturday-anchored, June 2026) ──');
  // June 2026: Jun 1 = Mon; Sat-anchored weeks → wk1 Jun1-5, wk2 6-12, wk3 13-19, wk4 20-26, wk5 27-30
  const wk = (d) => weekOfMonth(D(d));
  ok(wk(3) === 1, `Jun 3 → wk1 (got ${wk(3)})`);
  ok(wk(10) === 2, `Jun 10 → wk2 (got ${wk(10)})`);
  ok(wk(16) === 3, `Jun 16 → wk3 (got ${wk(16)})`);
  ok(wk(23) === 4, `Jun 23 → wk4 (got ${wk(23)})`);
  ok(wk(29) === 5, `Jun 29 → wk5 (got ${wk(29)})`);

  console.log('\n── Check-in grant window / tokens / same-day ──');
  const vipGrant = { week_start: '2026-06-13', valid_through: '2026-06-26', meeting_tokens: 2, budget_minutes: null, package: 'vip' };
  ok(meetingInWindow(D(23), vipGrant), 'Jun 23 in window');
  ok(meetingInWindow(D(26), vipGrant), 'Jun 26 (last day) in window');
  ok(!meetingInWindow(D(30), vipGrant), 'Jun 30 NOT in window (week after next)');
  ok(!meetingInWindow(D(10), vipGrant), 'Jun 10 NOT in window (past)');
  const gw = grantWindow(D(16));
  ok(gw.weekStart.toISODate() === '2026-06-13', `grant week_start = Jun 13 (got ${gw.weekStart.toISODate()})`);
  ok(gw.validThrough.toISODate() === '2026-06-26', `grant valid_through = Jun 26 (got ${gw.validThrough.toISODate()})`);
  ok(grantRemaining(vipGrant, { count: 1, minutes: 20 }) === 1, 'VIP remaining 1 after 1 booked');
  ok(grantRemaining(vipGrant, { count: 2, minutes: 40 }) === 0, 'VIP remaining 0 after 2 booked');

  console.log('\n── grantCarriesCrossMeeting: window must include the phase week ──');
  const p3 = { primary_teacher: 'aaron', package: 'vip', phase: 3 };
  ok(grantCarriesCrossMeeting(p3, { week_start: '2026-06-13' }) === true, 'check-in DURING the phase week (wk3) carries the cross-meeting');
  ok(grantCarriesCrossMeeting(p3, { week_start: '2026-06-06' }) === true, 'check-in the WEEK BEFORE the phase week carries it (window reaches wk3)');
  ok(grantCarriesCrossMeeting(p3, { week_start: '2026-06-20' }) === false, 'check-in AFTER the phase week does NOT carry it');
  ok(grantCarriesCrossMeeting({ primary_teacher: 'ryan', package: 'vip', phase: 1 }, { week_start: '2026-06-13' }) === false,
    'phase-1 senior, wk3/wk4 grant → no cross-meeting');

  console.log('\n── VIP carrying the cross (primary=aaron, phase=3) — capacity reservation, any-day cross ──');
  const vip = { primary_teacher: 'aaron', package: 'vip', phase: 3, student_sheet_id: 'x' };
  const st = (bookings) => ({ grant: vipGrant, bookings });
  // The reachability fix: the cross-meeting is bookable on ANY in-window day, not just phase-week days.
  ok(canBookOnDate(vip, D(23), 'ryan', 20, st([])).ok, 'cross (ryan) bookable on Jun 23 — wk4, NOT the phase week');
  ok(canBookOnDate(vip, D(23), 'aaron', 20, st([])).ok, 'primary (aaron) bookable while cross owed (one slot reserved, no hard "first")');
  const bA23 = bk('aaron', 20, '2026-06-23');
  ok(canBookOnDate(vip, D(24), 'aaron', 20, st([bA23])).reason === 'cross-reserved', '2nd primary blocked — last slot reserved for the cross');
  ok(canBookOnDate(vip, D(24), 'ryan', 20, st([bA23])).ok, 'cross still bookable after a primary');
  const bR24 = bk('ryan', 20, '2026-06-24');
  ok(canBookOnDate(vip, D(25), 'ryan', 20, st([bA23, bR24])).reason === 'secondary-done', 'only one cross-meeting per grant');
  ok(canBookOnDate(vip, D(25), 'aaron', 20, st([bA23, bR24])).reason === 'tokens-used', 'both tokens spent (1 primary + 1 cross)');
  ok(canBookOnDate(vip, D(23), 'aaron', 30, st([])).reason === 'bad-duration', 'VIP only books 20-min');
  ok(canBookOnDate(vip, D(23), 'aaron', 20, st([bA23])).reason === 'same-day', 'two meetings same day REFUSED');
  ok(canBookOnDate(vip, D(30), 'aaron', 20, st([])).reason === 'out-of-window', 'out-of-window REFUSED');
  ok(canBookOnDate(vip, D(23), 'aaron', 20, { grant: null, bookings: [] }).reason === 'no-grant', 'no active grant → must check in');

  console.log('\n── VIP NOT carrying the cross (primary=ryan, phase=1) — the Christine case ──');
  const vipR = { primary_teacher: 'ryan', package: 'vip', phase: 1, student_sheet_id: 'y' };
  ok(canBookOnDate(vipR, D(23), 'ryan', 20, st([])).ok, 'primary cashes token 1 (Jun 23)');
  const bR23 = bk('ryan', 20, '2026-06-23');
  ok(canBookOnDate(vipR, D(25), 'ryan', 20, st([bR23])).ok, 'primary cashes token 2 (no slot reserved — no cross this grant)');
  const bR25 = bk('ryan', 20, '2026-06-25');
  ok(canBookOnDate(vipR, D(24), 'ryan', 20, st([bR23, bR25])).reason === 'tokens-used', 'in-window 3rd REFUSED — tokens used');
  ok(canBookOnDate(vipR, D(23), 'aaron', 20, st([])).reason === 'wrong-teacher', 'secondary NOT bookable when the grant carries no cross-meeting');

  console.log('\n── Once-a-month cross-meeting (month-level, across grants) ──');
  // A fresh grant (no bookings of its own) that still reaches the phase week, but
  // the student already booked a cross-meeting earlier this month under a PRIOR grant.
  const stCross = (crossDates) => ({ grant: vipGrant, bookings: [], crossMeetings: crossDates });
  ok(canBookOnDate(vip, D(23), 'ryan', 20, stCross(['2026-06-15'])).reason === 'secondary-done',
    'no 2nd cross-meeting in the same month (a prior-grant cross counts)');
  ok(canBookOnDate(vip, D(23), 'aaron', 20, stCross(['2026-06-15'])).ok,
    'primary is NOT reserved once the month’s cross is already booked');
  ok(canBookOnDate(vip, D(24), 'aaron', 20, { grant: vipGrant, bookings: [bk('aaron', 20, '2026-06-23')], crossMeetings: ['2026-06-15'] }).ok,
    'both primary tokens usable when the cross is already done for the month');
  ok(canBookOnDate(vip, D(23), 'ryan', 20, stCross(['2026-07-04'])).ok,
    'a cross in a DIFFERENT month does not block this month’s cross');

  console.log('\n── Comprehensive carrying (primary=aaron, phase=3) — up to 2 ──');
  const compGrant = { ...vipGrant, package: 'comprehensive' };
  const comp = { primary_teacher: 'aaron', package: 'comprehensive', phase: 3, student_sheet_id: 'z' };
  const stC = (bookings) => ({ grant: compGrant, bookings });
  ok(canBookOnDate(comp, D(23), 'aaron', 20, stC([])).ok, 'comp primary bookable');
  ok(canBookOnDate(comp, D(23), 'ryan', 20, stC([])).ok, 'comp cross bookable on any in-window day');
  ok(canBookOnDate(comp, D(24), 'aaron', 20, stC([bk('aaron', 20, '2026-06-23')])).reason === 'cross-reserved', 'comp reserves a slot for the cross');

  console.log('\n── Essential carrying (30-min budget, primary=aaron, phase=3) ──');
  const essGrant = { week_start: '2026-06-13', valid_through: '2026-06-26', meeting_tokens: 0, budget_minutes: 30, package: 'essential' };
  const ess = { primary_teacher: 'aaron', package: 'essential', phase: 3, student_sheet_id: 'e' };
  const stE = (bookings) => ({ grant: essGrant, bookings });
  ok(canBookOnDate(ess, D(23), 'aaron', 30, stE([])).reason === 'cross-reserved', 'primary 1×30 blocked while cross owed — 15 held for the cross');
  ok(canBookOnDate(ess, D(23), 'aaron', 15, stE([])).ok, 'primary 15 ok (leaves 15 for the cross)');
  ok(canBookOnDate(ess, D(23), 'ryan', 30, stE([])).ok, 'cross can take the full 30 if booked first');
  const eA15 = bk('aaron', 15, '2026-06-23');
  ok(canBookOnDate(ess, D(24), 'aaron', 15, stE([eA15])).reason === 'cross-reserved', '2nd primary 15 blocked — cross still owed');
  ok(canBookOnDate(ess, D(24), 'ryan', 15, stE([eA15])).ok, 'cross 15 fits the remaining budget');
  ok(canBookOnDate(ess, D(25), 'aaron', 15, stE([eA15, bk('ryan', 15, '2026-06-24')])).reason === 'budget-used', 'budget spent (15 primary + 15 cross)');
  // grantRemaining now divides the budget by the SMALLEST denomination (15), so a
  // 30-min budget reads as 2 meetings — not floor(30/20)=1 (the old hardcoded /20 bug).
  ok(grantRemaining(essGrant, { count: 0, minutes: 0 }) === 2, 'Essential remaining 2 on a fresh 30-min budget (2×15)');
  ok(grantRemaining(essGrant, { count: 1, minutes: 15 }) === 1, 'Essential remaining 1 after a 15');
  ok(grantRemaining(essGrant, { count: 1, minutes: 30 }) === 0, 'Essential remaining 0 after a 30 (budget spent)');

  console.log('\n── Essential NOT carrying (primary=ryan, phase=1) ──');
  const essR = { primary_teacher: 'ryan', package: 'essential', phase: 1, student_sheet_id: 'er' };
  ok(canBookOnDate(essR, D(23), 'ryan', 30, { grant: essGrant, bookings: [] }).ok, 'primary 1×30 ok when no cross is owed');
  ok(canBookOnDate(essR, D(23), 'aaron', 15, { grant: essGrant, bookings: [] }).reason === 'wrong-teacher', 'secondary not bookable (no cross this grant)');

  console.log('\n── buildSeniorBookingPlan: the reported bug, fixed (now = Fri Jun 19) ──');
  const now = D(19);
  // Srikar: comprehensive, primary aaron, phase 3, grant Jun 13–26 (carries the cross).
  const srikarPlan = buildSeniorBookingPlan(comp, now, stC([]));
  const srikarSlugs = srikarPlan.meetings.map((m) => m.slug).sort().join(',');
  ok(srikarSlugs === 'aaron,ryan', `Srikar can book BOTH teachers (got ${srikarSlugs || 'none'})`);
  ok(srikarPlan.meetings.some((m) => m.slug === 'ryan' && m.kind === 'cross'), 'Srikar: Ryan offered as the cross-meeting (the original complaint, now fixed)');
  ok(srikarPlan.thisWeek.start === '2026-06-13' && srikarPlan.thisWeek.end === '2026-06-19', 'plan surfaces the real "this week" range (Jun 13–19)');
  // Test Student: VIP, primary ryan, phase 4, grant Jun 13–26 (carries: phase wk4 is the 2nd week of the window).
  const ts = { primary_teacher: 'ryan', package: 'vip', phase: 4, student_sheet_id: 't' };
  const tsPlan = buildSeniorBookingPlan(ts, now, st([]));
  const tsSlugs = tsPlan.meetings.map((m) => m.slug).sort().join(',');
  ok(tsSlugs === 'aaron,ryan', `Test Student can book BOTH teachers (got ${tsSlugs || 'none'})`);
  ok(tsPlan.carriesCross === true, 'Test Student grant carries the cross-meeting (phase wk4 in window)');

  console.log('\n── 5th week never a phase week (phase only 1-4) ──');
  ok(!assignedPlanForWeek({ primary_teacher: 'ryan', package: 'vip', phase: 4 }, D(29)).isPhaseWeek, 'phase-4 senior in wk5 is NOT a phase week');

  console.log('\n── One-off "extra meeting" track (separate from weekly cadence) ──');
  // A one-off bookable Jun 18–Jul 2 for a 15-min with Ryan. Window/teacher/length must all match.
  const oo = { id: 'oo1', teacher: 'ryan', minutes: 15, valid_from: '2026-06-18', valid_through: '2026-07-02', status: 'active' };
  // vipR: primary=ryan, NO active grant → weekly would deny everything.
  const stOO = (oneoffs) => ({ grant: null, bookings: [], oneoffs });
  ok(canBookOnDate(vipR, D(23), 'ryan', 15, stOO([oo])).via === 'oneoff', 'one-off authorizes a meeting with NO weekly grant (additive)');
  ok(canBookOnDate(vipR, D(23), 'ryan', 30, stOO([oo])).ok === false, 'one-off does NOT match a different length (15 ≠ 30)');
  ok(canBookOnDate(vipR, D(23), 'aaron', 15, stOO([oo])).ok === false, 'one-off does NOT match a different teacher');
  ok(canBookOnDate(vipR, D(17), 'ryan', 15, stOO([oo])).ok === false, 'one-off respects its window (Jun 17 < valid_from)');
  ok(canBookOnDate(vipR, D(23), 'ryan', 15, stOO([{ ...oo, status: 'consumed' }])).ok === false, 'a consumed one-off is not bookable');
  // Weekly is tried FIRST: when the weekly grant already covers it, the weekly track is charged (additive, not a substitute).
  ok(canBookOnDate(vipR, D(23), 'ryan', 20, { grant: vipGrant, bookings: [], oneoffs: [{ ...oo, minutes: 20 }] }).via === 'weekly', 'weekly cadence is spent before the one-off');
  // It surfaces in the booking plan as a separate list, even with no weekly grant.
  const ooPlan = buildSeniorBookingPlan(vipR, D(19), stOO([oo]));
  ok(ooPlan.oneoffs.length === 1 && ooPlan.oneoffs[0].slug === 'ryan' && ooPlan.oneoffs[0].minutes === 15, 'plan surfaces the one-off as its own entry');
  ok(ooPlan.meetings.length === 0, 'plan.meetings (weekly cadence) stays empty — one-off is NOT mixed in');
}

async function rosterTests(sb, live, get) {
  console.log('\n── Roster (Supabase `seniors`) ──');
  const { data: seniors, error } = await sb.from('seniors').select('*').eq('active', true);
  if (error) {
    ok(false, `Supabase read failed: ${error.message}`);
    return;
  }
  // 18 roster seniors + the permanent "Test Student" fixture (see ingestSeniors.cjs).
  ok(seniors.length === 19, `19 active seniors (got ${seniors.length})`);
  for (const s of seniors) {
    ok(!!PACKAGE_RULES[s.package], `${s.student_name}: known package "${s.package}"`);
    ok(['aaron', 'ryan'].includes(s.primary_teacher), `${s.student_name}: valid teacher`);
    ok(s.phase >= 1 && s.phase <= 4, `${s.student_name}: phase in 1-4`);
  }

  if (!live) return;

  console.log('\n── Live current-week booked/remaining (read-only calendar) ──');
  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  const calendar = google.calendar({ version: 'v3', auth });
  const CAL = { aaron: get('GOOGLE_CALENDAR_ID_AARON'), ryan: get('GOOGLE_CALENDAR_ID_RYAN') };
  const now = DateTime.now().setZone(ZONE);
  const ws = startOfSaturdayWeek(now);
  const we = ws.plus({ weeks: 1 });

  for (const s of seniors) {
    const meetings = [];
    for (const slug of ['aaron', 'ryan']) {
      if (!CAL[slug]) continue;
      let items = [];
      try {
        items = (await calendar.events.list({ calendarId: CAL[slug], timeMin: ws.toISO(), timeMax: we.toISO(), singleEvents: true })).data.items || [];
      } catch { /* ignore */ }
      const email = String(s.student_email).toLowerCase();
      const nameLc = String(s.student_name).toLowerCase();
      for (const e of items) {
        if (e.status === 'cancelled') continue;
        const pep = e.extendedProperties?.private || {};
        if ((pep.studentEmail && pep.studentEmail.toLowerCase() === email) || (e.summary && e.summary.toLowerCase().includes(nameLc))) {
          const start = DateTime.fromISO(e.start?.dateTime || e.start?.date).setZone(ZONE);
          const end = DateTime.fromISO(e.end?.dateTime || e.end?.date).setZone(ZONE);
          meetings.push({ slug, start, minutes: Math.round(end.diff(start, 'minutes').minutes) });
        }
      }
    }
    const booked = bookedForWeekOf(meetings, now);
    const plan = assignedPlanForWeek(s, now);
    console.log(
      `  ${s.student_name.padEnd(22)} ${s.package.padEnd(13)} wk${weekOfMonth(now)}${plan.isPhaseWeek ? ' (PHASE→' + plan.secondarySlug + ')' : ''}  booked a:${booked.aaron.count} r:${booked.ryan.count}`
    );
  }
}

async function main() {
  const live = process.argv.includes('--live');
  const get = loadEnv();
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

  pureLogicTests();
  await rosterTests(sb, live, get);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFAILURES:');
    fails.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
  console.log('✓ All senior-booking assertions green.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
