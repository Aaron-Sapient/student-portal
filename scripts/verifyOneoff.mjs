/**
 * verifyOneoff.mjs — live, self-cleaning smoke test of the senior one-off track.
 * Inserts a one-off grant for a SYNTHETIC sheet id (no real student touched),
 * reads it back, asserts the pure gate (seniorsCore) authorizes it through the same
 * row shape the app uses, then deletes the row. Confirms the table columns line up
 * with the code end-to-end. (Uses the Supabase client directly because the app's
 * lib/seniors.js relies on Next's extensionless import resolution.)
 *
 *   node scripts/verifyOneoff.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import { createClient } from '@supabase/supabase-js';
import { canBookOnDate, buildSeniorBookingPlan } from '../lib/seniorsCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZONE = 'America/Los_Angeles';

const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
const getEnv = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
};
const sb = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const TABLE = 'senior_oneoff_grants';

let pass = 0, fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.log(`  ✗ ${m}`)));

const SHEET = 'TEST_ONEOFF_VERIFY_DELETE_ME';
const senior = { student_sheet_id: SHEET, primary_teacher: 'ryan', package: 'vip', phase: 1 };
const today = DateTime.now().setZone(ZONE).startOf('day');
const inWindow = today.plus({ days: 3 });

const loadActive = async () => {
  const { data } = await sb
    .from(TABLE)
    .select('id, teacher, minutes, valid_from, valid_through, status')
    .eq('student_sheet_id', SHEET)
    .eq('status', 'active');
  return data || [];
};

try {
  // INSERT — the exact columns lib/seniors.createOneoffGrant writes.
  const { data: ins, error: insErr } = await sb
    .from(TABLE)
    .insert({
      student_sheet_id: SHEET,
      student_email: 'verify@example.com',
      teacher: 'ryan',
      minutes: 15,
      valid_from: today.toISODate(),
      valid_through: today.plus({ days: 14 }).toISODate(),
      note: 'verify script',
      granted_by: 'verify',
    })
    .select()
    .single();
  ok(!insErr && ins?.id, `insert accepts all columns (${insErr?.message || 'ok'})`);
  const id = ins?.id;

  const oneoffs = await loadActive();
  ok(oneoffs.length === 1, `read back as active (got ${oneoffs.length})`);

  const state = { grant: null, bookings: [], oneoffs };
  ok(canBookOnDate(senior, inWindow, 'ryan', 15, state).via === 'oneoff', 'gate authorizes via one-off (no weekly grant)');
  ok(canBookOnDate(senior, inWindow, 'aaron', 15, state).ok === false, 'wrong teacher rejected');
  ok(canBookOnDate(senior, inWindow, 'ryan', 30, state).ok === false, 'wrong length rejected');
  ok(canBookOnDate(senior, today.minus({ days: 1 }), 'ryan', 15, state).ok === false, 'out-of-window (yesterday) rejected');

  const plan = buildSeniorBookingPlan(senior, today, state);
  ok(plan.oneoffs.length === 1 && plan.oneoffs[0].slug === 'ryan' && plan.oneoffs[0].minutes === 15, 'plan surfaces the one-off');
  ok(plan.meetings.length === 0, 'plan.meetings stays empty (one-off not mixed into weekly cadence)');

  // consume → inactive; cancel-by-event → active again
  await sb.from(TABLE).update({ status: 'consumed', calendar_event_id: 'EVT_VERIFY_123' }).eq('id', id).eq('status', 'active');
  ok((await loadActive()).length === 0, 'consume removes it from active');
  await sb.from(TABLE).update({ status: 'active', calendar_event_id: null }).eq('calendar_event_id', 'EVT_VERIFY_123').eq('status', 'consumed');
  ok((await loadActive()).length === 1, 'cancel-by-event returns it to active');
} finally {
  await sb.from(TABLE).delete().eq('student_sheet_id', SHEET);
  ok((await loadActive()).length === 0, 'cleanup deleted the synthetic row');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
