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
  canBook,
  startOfSaturdayWeek,
  bookedForWeekOf,
  emptyWeek,
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

// Simulate a booking sequence; each step = [teacher, mins, expectedOk, expectedReason?].
// On an ok step we accumulate the booking so later steps see it.
function runSequence(label, senior, dt, steps) {
  const booked = emptyWeek();
  steps.forEach(([teacher, mins, expOk, expReason], i) => {
    const v = canBook(senior, dt, teacher, mins, booked);
    ok(
      v.ok === expOk && (expOk || !expReason || v.reason === expReason),
      `${label} step ${i + 1} (${teacher} ${mins}m): expected ${expOk ? 'OK' : 'DENY:' + expReason}, got ${v.ok ? 'OK' : 'DENY:' + v.reason}`
    );
    if (v.ok) {
      booked[teacher].count += 1;
      booked[teacher].minutes += mins;
    }
  });
}

function pureLogicTests() {
  console.log('\n── Week-of-month (Saturday-anchored, June 2026: 1=Jun30 wk… ) ──');
  // June 2026: Jun 1 = Mon; Sat-anchored weeks → wk1 Jun1-5, wk2 6-12, wk3 13-19, wk4 20-26, wk5 27-30
  const wk = (d) => weekOfMonth(DateTime.fromObject({ year: 2026, month: 6, day: d }, { zone: ZONE }));
  ok(wk(3) === 1, `Jun 3 → wk1 (got ${wk(3)})`);
  ok(wk(10) === 2, `Jun 10 → wk2 (got ${wk(10)})`);
  ok(wk(16) === 3, `Jun 16 → wk3 (got ${wk(16)})`);
  ok(wk(23) === 4, `Jun 23 → wk4 (got ${wk(23)})`);
  ok(wk(29) === 5, `Jun 29 → wk5 (got ${wk(29)})`);

  const D = (d) => DateTime.fromObject({ year: 2026, month: 6, day: d }, { zone: ZONE });
  const nonPhase = D(10); // wk2
  const phase = D(16); // wk3

  console.log('\n── VIP (primary=aaron, phase=3, secondary=ryan) ──');
  const vip = { primary_teacher: 'aaron', package: 'vip', phase: 3 };
  runSequence('VIP non-phase', vip, nonPhase, [
    ['ryan', 30, false, 'wrong-teacher'],
    ['aaron', 30, true],
    ['aaron', 30, true],
    ['aaron', 30, false, 'week-full'],
  ]);
  runSequence('VIP phase', vip, phase, [
    ['aaron', 30, false, 'secondary-first'],
    ['ryan', 30, true],
    ['ryan', 30, false, 'secondary-done'],
    ['aaron', 30, true],
    ['aaron', 30, false, 'week-full'],
  ]);

  console.log('\n── Comprehensive (primary=aaron, phase=3) — up to 2 ──');
  const comp = { primary_teacher: 'aaron', package: 'comprehensive', phase: 3 };
  runSequence('Comp non-phase', comp, nonPhase, [
    ['aaron', 30, true],
    ['aaron', 30, true],
    ['aaron', 30, false, 'week-full'],
    ['ryan', 30, false, 'wrong-teacher'],
  ]);
  runSequence('Comp phase', comp, phase, [
    ['aaron', 30, false, 'secondary-first'],
    ['ryan', 30, true],
    ['aaron', 30, true],
    ['aaron', 30, false, 'week-full'],
  ]);

  console.log('\n── Essential (primary=aaron, phase=3) — 40-min budget ──');
  const ess = { primary_teacher: 'aaron', package: 'essential', phase: 3 };
  runSequence('Ess non-phase 1×40', ess, nonPhase, [
    ['ryan', 40, false, 'wrong-teacher'],
    ['aaron', 40, true],
    ['aaron', 20, false, 'budget-used'],
  ]);
  runSequence('Ess non-phase 2×20', ess, nonPhase, [
    ['aaron', 20, true],
    ['aaron', 40, false, 'budget-used'],
    ['aaron', 20, true],
    ['aaron', 20, false, 'budget-used'],
  ]);
  runSequence('Ess phase 40→secondary', ess, phase, [
    ['aaron', 40, false, 'secondary-first'],
    ['ryan', 40, true],
    ['aaron', 20, false, 'budget-used'],
  ]);
  runSequence('Ess phase 20/20 split', ess, phase, [
    ['ryan', 20, true],
    ['ryan', 20, false, 'secondary-done'],
    ['aaron', 20, true],
    ['aaron', 20, false, 'budget-used'],
  ]);
  // Anti-gaming: the 40-min budget spans BOTH teachers. A fresh phase week offers
  // 40 or 20 for the cross-meeting, but once a 20 is booked with the primary, the
  // cross-meeting can only be a 20 — a student can't split into 60 total min.
  ok(
    canBook(ess, phase, 'ryan', 40, emptyWeek()).ok && canBook(ess, phase, 'ryan', 20, emptyWeek()).ok,
    'Ess phase fresh: cross-meeting offers BOTH 40 and 20'
  );
  const essPrimary20 = { aaron: { count: 1, minutes: 20 }, ryan: { count: 0, minutes: 0 } };
  ok(
    canBook(ess, phase, 'ryan', 40, essPrimary20).reason === 'budget-used' &&
      canBook(ess, phase, 'ryan', 20, essPrimary20).ok,
    'Ess phase: a pre-existing primary 20 caps the cross-meeting at 20 (budget enforced)'
  );

  console.log('\n── 5th week never a phase week (phase only 1-4) ──');
  const wk5 = D(29);
  const vipP4 = { primary_teacher: 'ryan', package: 'vip', phase: 4 };
  ok(!assignedPlanForWeek(vipP4, wk5).isPhaseWeek, 'phase-4 senior in wk5 is NOT a phase week');
  ok(assignedPlanForWeek(vipP4, wk5).secondaryRequired === false, 'wk5 → no cross-meeting required');
}

async function rosterTests(sb, live, get) {
  console.log('\n── Roster (Supabase `seniors`) ──');
  const { data: seniors, error } = await sb.from('seniors').select('*').eq('active', true);
  if (error) {
    ok(false, `Supabase read failed: ${error.message}`);
    return;
  }
  ok(seniors.length === 18, `18 active seniors (got ${seniors.length})`);
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
