/**
 * verifySessionsCli.mjs — end-to-end, self-cleaning check of scripts/sessions.mjs against
 * the LIVE Supabase, on a SYNTHETIC student (explicit --sheet-id/--email identity, never a
 * roster row). Exercises: declarative `set` (create / idempotent re-run / supersede),
 * `add` duplicate guard (+ --allow-duplicate), `end` by short id, `show --json`, and the
 * spec validator's refusals. Deletes every row it created at the end (and at the start,
 * in case a prior run died mid-way).
 *
 *   node scripts/verifySessionsCli.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLI = path.join(__dirname, 'sessions.mjs');
const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const getEnv = (k) => env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1]?.replace(/^['"]|['"]$/g, '') ?? null;
const sb = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });

const SHEET = 'TEST_SESSIONS_CLI_DELETE_ME';
const EMAIL = 'test-sessions-cli@example.invalid';
const ID = ['--sheet-id', SHEET, '--email', EMAIL, '--name', 'CLI Test Student'];

let pass = 0, fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.log(`  ✗ ${m}`)));
const run = (args, { expectExit = 0 } = {}) => {
  try {
    const out = execFileSync('node', ['--no-warnings', CLI, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    ok(expectExit === 0, `expected exit ${expectExit}, got 0 for: ${args.join(' ')}`);
    return { code: 0, out };
  } catch (e) {
    ok(e.status === expectExit, `expected exit ${expectExit}, got ${e.status} for: ${args.join(' ')}\n${e.stderr}`);
    return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
};
const plans = async () => (await sb.from('project_meeting_plans').select('*').eq('student_sheet_id', SHEET).order('created_at')).data || [];
const cleanup = async () => { await sb.from('project_meeting_plans').delete().eq('student_sheet_id', SHEET); };

await cleanup();
try {
  // 1) set: create two
  run(['set', 'aaron/30/EAP English', 'ryan/30/Microbusiness Incubator', ...ID, '--commit', '--note', 'verify run']);
  let ps = await plans();
  ok(ps.length === 2 && ps.every((p) => p.active), 'set created exactly 2 active plans');
  ok(ps.some((p) => p.teacher === 'aaron' && p.minutes === 30 && p.label === 'EAP English'), 'aaron/30/EAP English persisted verbatim');
  ok(ps.some((p) => p.teacher === 'ryan' && p.minutes === 30 && p.label === 'Microbusiness Incubator'), 'ryan/30/Microbusiness Incubator persisted verbatim');
  ok(ps.every((p) => p.student_email === EMAIL && p.granted_by && p.note === 'verify run'), 'email / granted_by / note recorded');
  const ids1 = ps.map((p) => p.id).sort();

  // 2) set again, same specs (format variants) → idempotent, same ids
  const r2 = run(['set', 'Aaron/30min/EAP English', 'ryan/30/Microbusiness Incubator', ...ID, '--commit']);
  ps = await plans();
  ok(ps.length === 2 && ps.map((p) => p.id).sort().join() === ids1.join(), 'idempotent re-run: same 2 plans, no new rows');
  ok(/= keep/.test(r2.out) && !/\+ create|− end|fix:/.test(r2.out), 'idempotent re-run reports keep only (no repairs)');
  // 2b) a case-variant label is the SAME session, kept — but repaired to the spec's casing
  const r2b = run(['set', 'aaron/30/eap english', 'ryan/30/Microbusiness Incubator', ...ID, '--commit']);
  ps = await plans();
  ok(ps.length === 2 && ps.some((p) => p.label === 'eap english'), 'keep repairs label casing to the spec');
  ok(/fix: relabel/.test(r2b.out), 'relabel is reported');
  run(['set', 'aaron/30/EAP English', 'ryan/30/Microbusiness Incubator', ...ID, '--commit']);
  ok((await plans()).some((p) => p.label === 'EAP English'), 'and back');

  // 3) set with one change → one ended (row kept, inactive, dated note), one created
  run(['set', 'aaron/30/EAP English', 'ryan/45/ACT Reading', ...ID, '--commit', '--note', 'package shift']);
  ps = await plans();
  const ended = ps.filter((p) => !p.active);
  const active = ps.filter((p) => p.active);
  ok(ps.length === 3, 'supersede keeps the ended row (3 rows total)');
  ok(ended.length === 1 && ended[0].label === 'Microbusiness Incubator' && /ended \d{4}-\d{2}-\d{2}.*superseded/.test(ended[0].note), 'ended row inactive with a dated supersede note');
  ok(active.length === 2 && active.some((p) => p.label === 'ACT Reading' && p.minutes === 45), 'new spec created active');
  ok(active.some((p) => p.id === ids1.find((id) => ps.find((q) => q.id === id)?.label === 'EAP English')), 'unchanged spec kept its original row');

  // 4) dry-run must not write
  run(['add', 'ryan/20/Weekly Meeting', ...ID]);
  ok((await plans()).length === 3, 'dry-run add wrote nothing');

  // 5) add duplicate refused (exit 2), allowed with --allow-duplicate
  run(['add', 'ryan/45/act reading', ...ID, '--commit'], { expectExit: 2 });
  ok((await plans()).filter((p) => p.active).length === 2, 'duplicate add refused — still 2 active');
  run(['add', 'ryan/45/ACT Reading', ...ID, '--commit', '--allow-duplicate']);
  ok((await plans()).filter((p) => p.active && p.label === 'ACT Reading').length === 2, '--allow-duplicate creates the second');

  // 6) end by short id, and by spec when unambiguous
  const dupes = (await plans()).filter((p) => p.active && p.label === 'ACT Reading');
  run(['end', dupes[0].id.slice(0, 8), ...ID, '--commit', '--reason', 'verify end']);
  ps = await plans();
  ok(!ps.find((p) => p.id === dupes[0].id).active && /verify end/.test(ps.find((p) => p.id === dupes[0].id).note), 'end by short id → inactive with reason');
  run(['end', 'ryan/45/ACT Reading', ...ID, '--commit']);
  ok((await plans()).filter((p) => p.active).length === 1, 'end by spec (now unambiguous) → 1 active left');
  run(['end', 'ryan/45/ACT Reading', ...ID, '--commit'], { expectExit: 2 });

  // 7) show --json
  const r7 = run(['show', ...ID, '--json']);
  const j = JSON.parse(r7.out);
  ok(j.weeklySessions.length === 1 && j.weeklySessions[0].plan.label === 'EAP English' && typeof j.weeklySessions[0].card.bookable === 'boolean', 'show --json: 1 active session with a card');
  ok(j.endedSessions.length === 3, 'show --json: 3 ended sessions');

  // 7b) argument hygiene: missing flag value, unknown flag, too-short id, explicit identity eats no spec
  run(['add', 'ryan/20/Weekly Meeting', ...ID, '--commit', '--note'], { expectExit: 2 });
  run(['add', 'ryan/20/Weekly Meeting', ...ID, '--comit'], { expectExit: 2 });
  run(['end', 'a', ...ID, '--commit'], { expectExit: 2 });
  ok((await plans()).filter((p) => p.active).length === 1, 'hygiene refusals wrote nothing');

  // 8) validator refusals never touch the DB
  const before = (await plans()).length;
  run(['add', 'art/15/Neuro', ...ID, '--commit'], { expectExit: 2 });
  run(['add', 'ryan/25/Thing', ...ID, '--commit'], { expectExit: 2 });
  run(['add', 'ryan/30/Parent Night', ...ID, '--commit'], { expectExit: 2 });
  run(['add', 'ryan/30', ...ID, '--commit'], { expectExit: 2 });
  run(['set', 'ryan/30/Same', 'ryan/30/same', ...ID, '--commit'], { expectExit: 2 });
  ok((await plans()).length === before, 'refused specs wrote nothing');
} finally {
  await cleanup();
  ok((await plans()).length === 0, 'cleanup removed every synthetic row');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
