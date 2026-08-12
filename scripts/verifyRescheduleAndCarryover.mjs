/**
 * verifyRescheduleAndCarryover.mjs — covers the two 2026-08-11 booking fixes.
 *
 *   node scripts/verifyRescheduleAndCarryover.mjs
 *
 * PART 1 (pure) — `excludeEventId`: a meeting being RESCHEDULED must not count against
 * the student while its new date is authorized. Each case asserts the DENIAL first
 * (the bug, still reproducible by omitting the exclusion) and then the fix, so a green
 * run can never mean "the gate stopped being consulted".
 *
 * PART 2 (pure) — `cross_month_override`: an unspent monthly cross-meeting survives a
 * superseding check-in, WITHOUT becoming a second entitlement.
 *
 * PART 3 (live, read-only) — replays every active senior's real upcoming meetings and
 * asserts each one is now reschedulable. Also confirms the DB column exists.
 *
 * Pure rules import straight from lib/seniorsCore.js (luxon-only); lib/seniors.js is
 * NOT importable from plain Node (extensionless Next imports), which is why the
 * carry-over DECISION lives in seniorsCore as carriedCrossMonth().
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import { createClient } from '@supabase/supabase-js';
import {
  canBookOnDate,
  carriedCrossMonth,
  grantCarriesCrossMeeting,
  phaseWeekMonthKey,
} from '../lib/seniorsCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZONE = 'America/Los_Angeles';
const EVT = 'EVENT_BEING_MOVED';

let pass = 0, fail = 0;
const ok = (cond, msg) => (cond ? (pass++, console.log(`  ✓ ${msg}`)) : (fail++, console.log(`  ✗ ${msg}`)));

// ── PART 1 — excludeEventId ────────────────────────────────────────────────
console.log('\nPART 1 — reschedule exclusion (each: bug reproduced, then fixed)');

const vip = { student_sheet_id: 'S', primary_teacher: 'ryan', package: 'vip', phase: 1 };
// Taewoo's real shape on 2026-08-11: both tokens spent, the cross already booked.
const grant = { id: 'g', week_start: '2026-08-01', valid_through: '2026-08-14', package: 'vip', meeting_tokens: 2, budget_minutes: null };
const moving = { teacher: 'aaron', minutes: 20, meeting_date: '2026-08-14', calendar_event_id: EVT };
const other  = { teacher: 'ryan',  minutes: 20, meeting_date: '2026-08-05', calendar_event_id: 'OTHER' };

const withMoving = { grant, bookings: [other, moving], crossMeetings: ['2026-08-14'], oneoffs: [] };
const excluded = {
  grant,
  bookings: withMoving.bookings.filter((b) => b.calendar_event_id !== EVT),
  crossMeetings: [],                       // loadSeniorBookingState filters this too
  oneoffs: [],
};
const d = (s) => DateTime.fromISO(s, { zone: ZONE });

ok(canBookOnDate(vip, d('2026-08-13'), 'aaron', 20, withMoving).reason === 'secondary-done',
   'BUG: cross-meeting reschedule denied (secondary-done) without the exclusion');
ok(canBookOnDate(vip, d('2026-08-13'), 'aaron', 20, excluded).ok === true,
   'FIXED: cross-meeting reschedule allowed with the exclusion');

// The crossMeetings half matters on its own: filtering only `bookings` is not enough.
const halfFixed = { grant, bookings: excluded.bookings, crossMeetings: ['2026-08-14'], oneoffs: [] };
ok(canBookOnDate(vip, d('2026-08-13'), 'aaron', 20, halfFixed).reason === 'secondary-done',
   'BUG: filtering `bookings` alone still denies — crossMeetings is a separate source');

// Same-day move (the "different time, same day" defect) for a primary-teacher meeting.
const ryanMoving = { teacher: 'ryan', minutes: 20, meeting_date: '2026-08-12', calendar_event_id: EVT };
const sameDayBug = { grant, bookings: [ryanMoving], crossMeetings: [], oneoffs: [] };
const sameDayFix = { grant, bookings: [], crossMeetings: [], oneoffs: [] };
ok(canBookOnDate(vip, d('2026-08-12'), 'ryan', 20, sameDayBug).reason === 'same-day',
   'BUG: moving a meeting to another time the SAME day denied (same-day)');
ok(canBookOnDate(vip, d('2026-08-12'), 'ryan', 20, sameDayFix).ok === true,
   'FIXED: same-day move allowed');

// Tokens fully spent — the ordinary reschedule case for a VIP. Uses a grant that
// carries NO cross-meeting (week_start 08-08), because when a cross IS owed the
// capacity reservation caps primary bookings at 1, so "2 primary + cross owed" is a
// state the gate can never actually produce.
const plainGrant = { id: 'g2', week_start: '2026-08-08', valid_through: '2026-08-21', package: 'vip', meeting_tokens: 2, budget_minutes: null };
const spent = {
  grant: plainGrant,
  bookings: [other, { teacher: 'ryan', minutes: 20, meeting_date: '2026-08-13', calendar_event_id: EVT }],
  crossMeetings: [], oneoffs: [],
};
ok(canBookOnDate(vip, d('2026-08-17'), 'ryan', 20, spent).reason === 'tokens-used',
   'BUG: reschedule denied (tokens-used) once the grant is spent');
ok(canBookOnDate(vip, d('2026-08-17'), 'ryan', 20,
     { ...spent, bookings: spent.bookings.filter((b) => b.calendar_event_id !== EVT) }).ok === true,
   'FIXED: allowed once the moving meeting is excluded');

// The reservation itself must SURVIVE the exclusion — excluding the meeting being
// moved must not let a primary meeting quietly eat the slot held for the cross.
ok(canBookOnDate(vip, d('2026-08-13'), 'ryan', 20,
     { grant, bookings: [{ teacher: 'ryan', minutes: 20, meeting_date: '2026-08-11', calendar_event_id: 'KEEP' },
                         { teacher: 'ryan', minutes: 20, meeting_date: '2026-08-12', calendar_event_id: EVT }]
             .filter((b) => b.calendar_event_id !== EVT),
       crossMeetings: [], oneoffs: [] }).reason === 'cross-reserved',
   'cross-meeting slot stays reserved even when a meeting is excluded');

// A one-off-funded meeting: rehydrated row must authorize, and stay identifiable.
const rehydrated = { id: 'oo1', teacher: 'aaron', minutes: 20, valid_from: '2026-08-12',
                     valid_through: '2026-08-31', status: 'active', rehydratedFrom: EVT };
const ooBug = { grant: null, bookings: [], crossMeetings: [], oneoffs: [] };
const ooFix = { grant: null, bookings: [], crossMeetings: [], oneoffs: [rehydrated] };
ok(canBookOnDate(vip, d('2026-08-20'), 'aaron', 20, ooBug).ok === false,
   'BUG: one-off-funded meeting unreschedulable (consumed row invisible)');
const ooVerdict = canBookOnDate(vip, d('2026-08-20'), 'aaron', 20, ooFix);
ok(ooVerdict.ok && ooVerdict.via === 'oneoff' && ooVerdict.oneoffId === 'oo1',
   'FIXED: rehydrated one-off authorizes and reports its id for re-pointing');

// ── PART 2 — cross_month_override ──────────────────────────────────────────
console.log('\nPART 2 — cross-meeting carry-over');

const outgoing = { week_start: '2026-08-01', valid_through: '2026-08-14' };   // August phase week
const incoming = { week_start: '2026-08-08', valid_through: '2026-08-21' };   // carries nothing

ok(grantCarriesCrossMeeting(vip, outgoing) && phaseWeekMonthKey(vip, outgoing) === '2026-08',
   'outgoing grant carries August’s cross-meeting');
ok(grantCarriesCrossMeeting(vip, incoming) === false,
   'BUG: successor grant carries none — this is how the entitlement vanished');

const override = carriedCrossMonth(vip, outgoing, incoming, [], DateTime.fromISO('2026-08-11', { zone: ZONE }));
ok(override === '2026-08', 'FIXED: carry-over resolves to 2026-08');

const carried = { ...incoming, cross_month_override: override };
ok(grantCarriesCrossMeeting(vip, carried) === true, 'stamped grant carries the cross again');
ok(canBookOnDate(vip, d('2026-08-20'), 'aaron', 20,
     { grant: { ...carried, meeting_tokens: 2, budget_minutes: null }, bookings: [], crossMeetings: [], oneoffs: [] }).ok === true,
   'secondary teacher bookable again on the carried grant');

// It must NOT become a second entitlement.
ok(canBookOnDate(vip, d('2026-08-20'), 'aaron', 20,
     { grant: { ...carried, meeting_tokens: 2, budget_minutes: null }, bookings: [], crossMeetings: ['2026-08-03'], oneoffs: [] }).reason === 'secondary-done',
   'still ONE per month: already-booked August cross blocks the carried one');
ok(carriedCrossMonth(vip, outgoing, incoming, ['2026-08'], DateTime.fromISO('2026-08-11', { zone: ZONE })) === null,
   'no override issued when the month’s cross is already booked');

// Chaining and the no-op cases. `now` is pinned inside August for all of these.
const inAug = DateTime.fromISO('2026-08-11', { zone: ZONE });
ok(carriedCrossMonth(vip, carried, { week_start: '2026-08-15', valid_through: '2026-08-28' }, [], inAug) === '2026-08',
   'chains across a further supersede (override read from the outgoing grant)');
ok(carriedCrossMonth(vip, null, incoming, [], inAug) === null, 'no live outgoing grant → no override');
ok(carriedCrossMonth(vip, { week_start: '2026-08-08', valid_through: '2026-08-21' }, incoming, [], inAug) === null,
   'outgoing carried nothing → no override');
ok(carriedCrossMonth(vip, outgoing, { week_start: '2026-07-25', valid_through: '2026-08-07' }, [], inAug) === null,
   'incoming already reaches the same phase week → no redundant override');

// EXPIRY — without it the month rides forward forever and re-arms the reservation.
ok(carriedCrossMonth(vip, carried, { week_start: '2026-09-05', valid_through: '2026-09-18' }, [],
     DateTime.fromISO('2026-09-08', { zone: ZONE })) === null,
   'a past month is NOT carried once that month is over');
ok(carriedCrossMonth(vip, carried, { week_start: '2026-08-15', valid_through: '2026-08-28' }, [],
     DateTime.fromISO('2026-08-28', { zone: ZONE })) === '2026-08',
   'still carried while the month is current');

// NO CAPACITY RESERVATION for a carried cross — otherwise the primary allowance is
// silently cut every week until the cross is taken.
const vipCarried = { grant: { ...carried, id: 'gc', meeting_tokens: 2, budget_minutes: null }, bookings: [], crossMeetings: [], oneoffs: [] };
const oneBooked = { ...vipCarried, bookings: [{ teacher: 'ryan', minutes: 20, meeting_date: '2026-08-18', calendar_event_id: 'X' }] };
ok(canBookOnDate(vip, d('2026-08-20'), 'ryan', 20, oneBooked).ok === true,
   'VIP keeps BOTH primary slots on a carried grant (no reservation)');
const naturallyOwed = { grant: { ...grant, id: 'gn' }, bookings: [{ teacher: 'ryan', minutes: 20, meeting_date: '2026-08-11', calendar_event_id: 'Y' }], crossMeetings: [], oneoffs: [] };
ok(canBookOnDate(vip, d('2026-08-13'), 'ryan', 20, naturallyOwed).reason === 'cross-reserved',
   'but a NATURALLY carried cross still reserves its slot (unchanged behavior)');

const essential = { student_sheet_id: 'E', primary_teacher: 'ryan', package: 'essential', phase: 1 };
const essCarried = { grant: { ...carried, id: 'ge', meeting_tokens: 0, budget_minutes: 30 }, bookings: [], crossMeetings: [], oneoffs: [] };
ok(canBookOnDate(essential, d('2026-08-20'), 'ryan', 30, essCarried).ok === true,
   'Essential keeps its full 30-min budget on a carried grant');

// ── PART 3 — live data (read-only) ─────────────────────────────────────────
console.log('\nPART 3 — live seniors (read-only)');

const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
const getEnv = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
const sb = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const OTHER = { aaron: 'ryan', ryan: 'aaron' };
const now = DateTime.now().setZone(ZONE);
const today = now.toISODate();

const { error: colErr } = await sb.from('senior_checkin_grants').select('cross_month_override').limit(1);
ok(!colErr, `cross_month_override column present (${colErr?.message || 'ok'})`);

// The CHECK must actually reject junk — a malformed month would make a grant carry an
// unspendable cross forever. `senior_checkin_grants` has an FK on student_sheet_id, so
// a synthetic row is refused for TWO possible reasons; assert the SQLSTATE to be sure
// it is the CHECK (23514) and not the foreign key (23503). No row is ever created.
const probeRow = (v) => ({
  student_sheet_id: 'TEST_OVERRIDE_CHECK_DELETE_ME', student_email: 'probe@example.com',
  week_start: '2026-08-08', valid_through: '2026-08-21', package: 'vip', meeting_tokens: 2,
  cross_month_override: v,
});
const { error: badErr } = await sb.from('senior_checkin_grants').insert(probeRow('August 2026'));
ok(badErr?.code === '23514',
   `CHECK rejects a malformed month (got ${badErr?.code || 'no error'} — want 23514 check_violation)`);
// Control: the SAME insert with a well-formed month must fail differently (on the FK),
// proving the rejection above was the CHECK and not something rejecting every probe.
const { error: goodErr } = await sb.from('senior_checkin_grants').insert(probeRow('2026-08'));
ok(goodErr?.code === '23503',
   `well-formed month clears the CHECK (got ${goodErr?.code || 'no error'} — want 23503 fk_violation)`);

const { data: seniors } = await sb.from('seniors').select('*').eq('active', true);
let stuckBefore = 0, stuckAfter = 0, checked = 0;

for (const s of seniors) {
  const { data: g } = await sb.from('senior_checkin_grants').select('*')
    .eq('student_sheet_id', s.student_sheet_id).eq('active', true).gte('valid_through', today)
    .order('valid_through', { ascending: false }).limit(1).maybeSingle();
  if (!g) continue;
  const { data: bk } = await sb.from('senior_bookings')
    .select('teacher, minutes, meeting_date, calendar_event_id').eq('grant_id', g.id).eq('status', 'active');
  const secondary = OTHER[s.primary_teacher];
  const { data: cross } = await sb.from('senior_bookings').select('meeting_date, calendar_event_id')
    .eq('student_sheet_id', s.student_sheet_id).eq('teacher', secondary).eq('status', 'active')
    .gte('meeting_date', now.startOf('month').toISODate())
    .lte('meeting_date', now.plus({ months: 1 }).endOf('month').toISODate());
  const { data: oo } = await sb.from('senior_oneoff_grants')
    .select('id, teacher, minutes, valid_from, valid_through, status')
    .eq('student_sheet_id', s.student_sheet_id).eq('status', 'active');

  for (const b of (bk || []).filter((x) => x.meeting_date >= today)) {
    checked++;
    const build = (exclude) => ({
      grant: g,
      bookings: (bk || []).filter((x) => !exclude || x.calendar_event_id !== b.calendar_event_id),
      crossMeetings: (cross || []).filter((x) => !exclude || x.calendar_event_id !== b.calendar_event_id)
        .map((x) => x.meeting_date),
      oneoffs: oo || [],
    });
    const movable = (state) => {
      let cur = DateTime.fromISO(g.week_start, { zone: ZONE });
      const end = DateTime.fromISO(g.valid_through, { zone: ZONE });
      while (cur <= end) {
        if (cur >= now.plus({ days: 1 }).startOf('day') && cur.toISODate() !== b.meeting_date
            && canBookOnDate(s, cur, b.teacher, b.minutes, state).ok) return true;
        cur = cur.plus({ days: 1 });
      }
      return false;
    };
    if (!movable(build(false))) stuckBefore++;
    if (!movable(build(true))) {
      stuckAfter++;
      console.log(`    · ${s.student_name} ${b.meeting_date} ${b.minutes}min w/ ${b.teacher} — still stuck`);
    }
  }
}
console.log(`  (${checked} upcoming meetings across ${seniors.length} active seniors)`);
// Deliberately NOT asserting stuckBefore > 0: it depends on the live roster's current
// state, so it would turn red for an unrelated reason once these meetings pass. It is
// reported for context; PART 1 is what actually pins the behavior.
console.log(`  · ${stuckBefore} of ${checked} would have been unreschedulable before the fix (context, not asserted)`);
ok(stuckAfter === 0, `no live upcoming meeting is unreschedulable: ${stuckAfter} stuck`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
