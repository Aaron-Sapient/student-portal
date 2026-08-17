#!/usr/bin/env node
/**
 * sessions.mjs — a student's WEEKLY SESSIONS (the project_meeting_plans track), from the
 * terminal, with no Clerk session and no hand-written SQL. THE entry point for "give
 * <student> a weekly <N>-min <topic> with <teacher>" (see BOOKING.md).
 *
 *   node scripts/sessions.mjs show "Olivia Lim"                 # the whole booking picture, all tracks
 *   node scripts/sessions.mjs list                              # every active weekly session, by student
 *   node scripts/sessions.mjs set  "Stacy Lim" "aaron/30/EAP English" "ryan/30/Microbusiness Incubator"
 *   node scripts/sessions.mjs add  "Stacy Lim" "ryan/45/ACT Reading"
 *   node scripts/sessions.mjs end  "Stacy Lim" "ryan/45/ACT Reading"     # or a plan id
 *
 *   Every write is a DRY RUN until you add --commit.  --notify emails the student (CC
 *   parents) a booking link for each NEW session.  --note "…" is stored on new plans;
 *   --reason "…" on ended ones.  --by <email> overrides granted_by (default: git user.email).
 *   --allow-duplicate permits a second identical active session (= 2/week; label them
 *   differently instead when you can).  --json on show/list prints machine-readable output.
 *   Writes run ends-then-creates; if a create fails mid-run just re-run the same `set` —
 *   it is idempotent and picks up where it stopped.
 *
 *   `set` is DECLARATIVE: it makes the student's active sessions equal exactly the specs
 *   given — keeps matches, adds what's missing, ends the rest (their rows stay, inactive,
 *   with a dated supersede note). Running it twice is a no-op. `add`/`end` are the
 *   incremental forms. A spec is teacher/minutes/label — "aaron/30/EAP English"; the label
 *   is what the student sees on the card, in the calendar title and in the email.
 *
 *   <student> = a name substring or an email, matched against the Master sheet
 *   (👩‍🎓 All Data). Ambiguity is refused with the candidates listed. For a student not on
 *   the roster yet, or a synthetic test row, pass the identity explicitly:
 *   --sheet-id <id> --email <e> [--name <n>].
 *
 * Rules (teacher / length / label / duplicate identity) come from lib/sessionSpec.js — the
 * same module the admin route and the developer panel use, so what this script accepts is
 * exactly what the app accepts. IO goes through lib/projectMeetings.js — the app's own
 * layer, not a copy. Reads only the Master sheet + Supabase; never writes the sheet.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { DateTime } from 'luxon';

// ── env: load .env.local into process.env BEFORE importing anything that reads it ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
if (process.argv.includes('--help') || process.argv.length < 3) usage();
{
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) die(`No .env.local at ${envPath}`);
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const { parseSessionSpec, sameSession, formatSession, SESSION_LENGTHS, SESSION_TEACHERS } = await import('../lib/sessionSpec.js');
const {
  ZONE, weekStartISO, buildProjectCard, loadProjectPlans, createProjectPlan, endProjectPlan,
  findActiveDuplicatePlan, loadProjectBookingsForPlan,
} = await import('../lib/projectMeetings.js');
const { getSupabaseClient, PROJECT_MEETING_PLANS, PROJECT_MEETING_BOOKINGS, SENIORS_TABLE, SENIOR_ONEOFF_GRANTS } = await import('../lib/supabase.js');
const { INSTRUCTOR_PUBLIC } = await import('../lib/instructorPublic.js');

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const VALUE_FLAGS = ['note', 'reason', 'by', 'sheet-id', 'email', 'name'];
const BOOL_FLAGS = ['commit', 'notify', 'json', 'allow-duplicate', 'help'];
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const key = a.slice(2);
  if (VALUE_FLAGS.includes(key)) {
    const v = argv[++i];
    // A missing value must not silently eat the next flag ("--note --commit" would store
    // "--commit" as the note and turn the run into a dry run).
    if (v === undefined || v.startsWith('--')) die(`--${key} needs a value.`, 2);
    flags[key] = v;
  } else if (BOOL_FLAGS.includes(key)) {
    flags[key] = true;
  } else {
    die(`Unknown flag --${key}. (Typo? --commit / --notify / --note / --reason / --by / --allow-duplicate / --json / --sheet-id / --email / --name)`, 2);
  }
}
const [cmd, ...restRaw] = positional;
// With an explicit identity there is no <student> positional — every remaining arg is a
// spec. Without this, "add aaron/30/X ryan/30/Y --sheet-id …" would eat the first spec as
// the (ignored) student query and silently create only the second.
const rest = flags['sheet-id'] ? [null, ...restRaw] : restRaw;
const COMMIT = !!flags.commit;
const NOTIFY = !!flags.notify;
const JSON_OUT = !!flags.json;

function die(msg, code = 1) { console.error(`✗ ${msg}`); process.exit(code); }
function usage() {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
  process.exit(process.argv.includes('--help') || process.argv.length < 3 ? 0 : 2);
}
if (!cmd || !['show', 'list', 'set', 'add', 'end'].includes(cmd)) usage();

const grantedBy = flags.by || (() => { try { return execSync('git config user.email', { cwd: ROOT }).toString().trim(); } catch { return null; } })() || `sessions.mjs (${process.env.USER || 'cli'})`;
const today = DateTime.now().setZone(ZONE);
const todayISO = today.toISODate();

// ── roster (Master sheet) ────────────────────────────────────────────────────
const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
// Column map (0-based) — the same indices app/api/home-data reads.
const COL = { name: 0, klass: 1, portalUrl: 6, email: 9, parent1: 10, parent2: 11, ryanToken: 51, aaronToken: 53, isART: 54, needsCheckin: 56 };

let rosterCache = null;
async function loadRoster() {
  if (rosterCache) return rosterCache;
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MASTER_SHEET_ID,
    range: `'${MASTER_TAB}'!A:BE`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = (res.data.values || []).slice(1); // drop header
  rosterCache = rows
    .map((r) => {
      const url = String(r[COL.portalUrl] || '');
      const sheetId = url.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] || null;
      const nc = r[COL.needsCheckin];
      return {
        name: String(r[COL.name] || '').trim(),
        klass: String(r[COL.klass] || '').trim(),
        email: String(r[COL.email] || '').trim().toLowerCase(),
        parents: [r[COL.parent1], r[COL.parent2]].map((e) => String(e || '').trim()).filter((e) => e.includes('@')),
        sheetId,
        isART: r[COL.isART] === true || r[COL.isART] === 'TRUE',
        inCheckinCadence: !(nc === false || /^false$/i.test(String(nc ?? '').trim())),
        ryanToken: r[COL.ryanToken] || null,
        aaronToken: r[COL.aaronToken] || null,
      };
    })
    .filter((s) => s.name);
  return rosterCache;
}

// Resolve <student> → { name, email, sheetId, parents, … }. Explicit identity flags win.
async function resolveStudent(q) {
  if (flags['sheet-id']) {
    if (!flags.email) die('--sheet-id needs --email too (the booking gate authorizes on the login email).');
    return { name: flags.name || flags.email, email: String(flags.email).toLowerCase(), sheetId: flags['sheet-id'], parents: [], explicit: true };
  }
  if (!q) die('Which student? Give a name substring or an email (or --sheet-id/--email).', 2);
  const roster = await loadRoster();
  const needle = q.trim().toLowerCase();
  const exactEmail = roster.filter((s) => s.email === needle);
  const hits = exactEmail.length ? exactEmail : roster.filter((s) => s.name.toLowerCase().includes(needle) || s.email.includes(needle));
  if (hits.length === 0) die(`No Master-sheet student matches “${q}”. (Not on the roster yet? Use --sheet-id <id> --email <e> --name "<n>".)`, 2);
  if (hits.length > 1) {
    console.error(`✗ “${q}” is ambiguous — ${hits.length} students match:`);
    for (const h of hits) console.error(`    ${h.name}  <${h.email || 'no email'}>  ${h.klass}`);
    process.exit(2);
  }
  const s = hits[0];
  if (!s.sheetId) die(`${s.name} has no portal sheet id in Master col G — the plan needs it (cards are keyed by sheet id).`);
  if (!s.email) console.warn(`⚠ ${s.name} has no login email in Master col J — a plan can be created, but the booking gate authorizes on email, so the card will 403 until col J is filled.`);
  return s;
}

// ── data ─────────────────────────────────────────────────────────────────────
const sb = getSupabaseClient();
const teacherName = (slug) => INSTRUCTOR_PUBLIC[slug]?.displayName || slug;
const fmtPlan = (p) => `${formatSession(p)}`;
const short = (id) => String(id).slice(0, 8);

async function upcomingBookings(planIds) {
  if (!planIds.length) return [];
  const { data } = await sb
    .from(PROJECT_MEETING_BOOKINGS)
    .select('plan_id, meeting_date, week_start, minutes, teacher, calendar_event_id')
    .in('plan_id', planIds)
    .eq('status', 'active')
    .gte('meeting_date', todayISO)
    .order('meeting_date');
  return data || [];
}

async function allPlansFor(sheetId) {
  const { data } = await sb.from(PROJECT_MEETING_PLANS).select('*').eq('student_sheet_id', sheetId).order('created_at');
  return data || [];
}

// ── show ─────────────────────────────────────────────────────────────────────
async function show(q) {
  const s = await resolveStudent(q);
  const [plansAll, seniorRes, oneoffRes] = await Promise.all([
    allPlansFor(s.sheetId),
    sb.from(SENIORS_TABLE).select('*').eq('student_sheet_id', s.sheetId).maybeSingle(),
    sb.from(SENIOR_ONEOFF_GRANTS).select('*').eq('student_sheet_id', s.sheetId).order('created_at'),
  ]);
  const senior = seniorRes.data || null;
  const oneoffs = oneoffRes.data || [];
  const active = plansAll.filter((p) => p.active);
  const ended = plansAll.filter((p) => !p.active);
  const upcoming = await upcomingBookings(active.map((p) => p.id));
  const cards = [];
  for (const p of active) {
    const bookings = await loadProjectBookingsForPlan(p.id, today);
    cards.push({ plan: p, card: buildProjectCard(p, bookings, today), upcoming: upcoming.filter((b) => b.plan_id === p.id) });
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ student: s, senior, weeklySessions: cards, endedSessions: ended, oneoffs }, null, 2));
    return;
  }

  console.log(`\n${s.name}  <${s.email || 'no email'}>${s.klass ? `  · ${s.klass}` : ''}`);
  console.log(`  sheet ${s.sheetId}${s.parents?.length ? `  · parents ${s.parents.join(', ')}` : ''}`);
  if (!s.explicit) {
    console.log(`\nCHECK-IN TRACK (Master tokens, weekly check-in → token)`);
    console.log(`  ${s.inCheckinCadence ? 'in the weekly check-in cadence' : 'OUT of the check-in cadence (Master col BE = FALSE)'}` +
      `  · Ryan token: ${s.ryanToken || '—'}  · Aaron token: ${s.aaronToken || '—'}  · ART: ${s.isART ? 'yes' : 'no'}`);
  }
  console.log(`\nSENIOR ESSAY TRACK (seniors table)`);
  console.log(senior
    ? `  ${senior.active ? 'active' : 'INACTIVE'} · ${senior.package} · primary ${teacherName(senior.primary_teacher)} · phase ${senior.phase}`
    : '  not a senior (no essay cadence)');
  console.log(`\nWEEKLY SESSIONS (project_meeting_plans) — ${active.length} active`);
  if (!active.length) console.log('  none');
  for (const { plan: p, card: c, upcoming: up } of cards) {
    const state = c.bookable ? `bookable ${c.window.start}→${c.window.end}` : c.bookedThisWeek ? 'booked this week' : 'not bookable right now';
    const emailBad = s.email && (p.student_email || '').toLowerCase() !== s.email;
    console.log(`  • ${fmtPlan(p)}  [${short(p.id)}]  ${state}${emailBad ? `  ⚠ plan email ${p.student_email || '∅'} ≠ login ${s.email} — card will 403 on booking; run \`set\` to repair` : ''}`);
    console.log(`      with ${teacherName(p.teacher)} · granted ${String(p.created_at).slice(0, 10)} by ${p.granted_by || '?'}${p.note ? ` · note: ${p.note}` : ''}`);
    for (const b of up) console.log(`      ↳ booked ${b.meeting_date} (${b.minutes}m, event ${b.calendar_event_id || '?'})`);
  }
  if (ended.length) {
    console.log(`  ended (${ended.length}):`);
    for (const p of ended) console.log(`    ◦ ${fmtPlan(p)}  [${short(p.id)}]  ${p.note ? `— ${p.note}` : ''}`);
  }
  console.log(`\nONE-OFF GRANTS (senior_oneoff_grants) — ${oneoffs.filter((o) => o.status === 'active').length} active`);
  if (!oneoffs.length) console.log('  none');
  for (const o of oneoffs) console.log(`  • ${o.status.padEnd(9)} ${teacherName(o.teacher)} ${o.minutes}m  ${o.valid_from}→${o.valid_through}${o.note ? `  — ${o.note}` : ''}`);
  console.log(`\nBooking page: /meetings  · plan deep links: /meetings/<teacher>?m=project:<planId>\n`);
}

// ── list ─────────────────────────────────────────────────────────────────────
async function list() {
  const { data } = await sb.from(PROJECT_MEETING_PLANS).select('*').eq('active', true).order('student_email').order('created_at');
  const plans = data || [];
  if (JSON_OUT) { console.log(JSON.stringify(plans, null, 2)); return; }
  const roster = await loadRoster().catch(() => []);
  const nameOf = (p) => roster.find((s) => s.sheetId === p.student_sheet_id)?.name || p.student_email || p.student_sheet_id;
  const byStudent = new Map();
  for (const p of plans) (byStudent.get(nameOf(p)) || byStudent.set(nameOf(p), []).get(nameOf(p))).push(p);
  console.log(`\n${plans.length} active weekly sessions across ${byStudent.size} students\n`);
  for (const [name, ps] of [...byStudent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`${name}`);
    for (const p of ps) console.log(`  • ${fmtPlan(p).padEnd(40)} [${short(p.id)}]  since ${String(p.created_at).slice(0, 10)}${p.note ? `  — ${p.note.slice(0, 80)}` : ''}`);
  }
  console.log('');
}

// ── writes ───────────────────────────────────────────────────────────────────
function parseSpecs(specs) {
  if (!specs.length) die('Give at least one session spec: teacher/minutes/label, e.g. "aaron/30/EAP English".', 2);
  const out = [];
  for (const raw of specs) {
    const v = parseSessionSpec(raw);
    if (!v.ok) die(v.error, 2);
    if (out.some((o) => sameSession(o, v.value)) && !flags['allow-duplicate']) {
      die(`“${raw}” is listed twice. Two identical sessions = the student can book it twice a week; if that's intended, label them differently (…A / …B) or pass --allow-duplicate.`, 2);
    }
    out.push(v.value);
  }
  return out;
}

async function notify(student, plan) {
  const { sendProjectMeetingGrantedEmail } = await import('../lib/checkinEmails.js');
  await sendProjectMeetingGrantedEmail({
    studentEmail: student.email,
    parentEmails: student.parents || [],
    studentName: student.name,
    label: plan.label,
    minutes: plan.minutes,
    teacherSlug: plan.teacher,
    teacherName: teacherName(plan.teacher),
    planId: plan.id,
  });
}

// A kept plan is "the same session" (teacher+length+label, label case-insensitive) — but
// the row can still drift from what was asked: label casing (the student sees the ROW's
// casing on the card/title/email) and student_email (the booking gate authorizes on it;
// a stale one renders a card that 403s). Repair both in place so `set` really means
// "exactly this". `desiredFor(p)` is the spec the plan matched, when there is one.
async function applyPlan(student, { keep, create, end, desiredFor = () => null }) {
  const mode = COMMIT ? 'COMMIT' : 'DRY RUN — add --commit to write';
  console.log(`\n${student.name}  <${student.email || 'no email'}>  · ${mode}\n`);
  const repairs = [];
  for (const p of keep) {
    const d = desiredFor(p);
    const patch = {};
    if (d && d.label !== p.label) patch.label = d.label;
    if (student.email && (p.student_email || '').toLowerCase() !== student.email) patch.student_email = student.email;
    const why = [patch.label ? `relabel “${p.label}” → “${patch.label}”` : null, patch.student_email ? `email ${p.student_email || '∅'} → ${patch.student_email}` : null].filter(Boolean);
    console.log(`  = keep   ${fmtPlan(p)}  [${short(p.id)}]${why.length ? `  (fix: ${why.join('; ')})` : ''}`);
    if (why.length) repairs.push({ p, patch });
  }
  // Two cards with the same name and different lengths is legal but confusing — say so.
  for (const c of create) {
    const twin = keep.find((p) => p.teacher === c.teacher && p.label.toLowerCase() === c.label.toLowerCase() && p.minutes !== c.minutes);
    if (twin) console.log(`  ⚠ ${formatSession(c)} shares a name with kept ${fmtPlan(twin)} — the student will see two “${c.label}” cards; consider distinct labels.`);
  }
  const upcoming = await upcomingBookings(end.map((p) => p.id));
  for (const p of end) {
    console.log(`  − end    ${fmtPlan(p)}  [${short(p.id)}]`);
    for (const b of upcoming.filter((b) => b.plan_id === p.id)) {
      console.log(`           ⚠ has an upcoming booking on ${b.meeting_date} — it STAYS on the calendar (cancel it from the developer panel if it shouldn't happen)`);
    }
  }
  for (const c of create) console.log(`  + create ${formatSession(c)}${NOTIFY ? '  (+ email booking link)' : ''}`);
  if (!keep.length && !create.length && !end.length) console.log('  (nothing to do)');
  if (!COMMIT) { console.log(''); return; }
  if (create.length && !student.email) console.warn('  ⚠ no login email — creating anyway; the card renders but booking will 403 until Master col J is filled.');

  const stamp = todayISO;
  for (const { p, patch } of repairs) {
    const { error } = await sb.from(PROJECT_MEETING_PLANS).update(patch).eq('id', p.id);
    if (error) throw error;
    console.log(`  ✓ fixed  ${fmtPlan({ ...p, ...patch })}  [${short(p.id)}]`);
  }
  for (const p of end) {
    await endProjectPlan(p.id, { reason: flags.reason || (cmd === 'set' ? `superseded (sessions.mjs set)${flags.note ? `: ${flags.note}` : ''}` : null), endedBy: grantedBy });
    console.log(`  ✓ ended  ${fmtPlan(p)}  [${short(p.id)}]`);
  }
  for (const c of create) {
    const plan = await createProjectPlan({
      studentSheetId: student.sheetId, studentEmail: student.email || null,
      teacher: c.teacher, minutes: c.minutes, label: c.label,
      note: flags.note || null, grantedBy,
    });
    console.log(`  ✓ created ${fmtPlan(plan)}  [${plan.id}]`);
    if (NOTIFY) {
      if (!student.email) { console.log('    ✗ no email to notify'); continue; }
      try { await notify(student, plan); console.log(`    ✉ emailed ${student.email}${student.parents?.length ? ` (cc ${student.parents.join(', ')})` : ''}`); }
      catch (e) { console.log(`    ✗ email failed (plan exists): ${e.message}`); }
    }
  }
  console.log(`\nDone (${stamp}). Verify: node scripts/sessions.mjs show "${student.email || student.name}"\n`);
}

async function set(q, specs) {
  const desired = parseSpecs(specs);
  const student = await resolveStudent(q);
  const current = await loadProjectPlans(student.sheetId);
  const keep = [], create = [];
  const matched = new Map(); // plan id → the spec it satisfies
  const unmatched = [...current];
  for (const d of desired) {
    const i = unmatched.findIndex((p) => sameSession(p, d));
    if (i >= 0) { const p = unmatched.splice(i, 1)[0]; keep.push(p); matched.set(p.id, d); } else create.push(d);
  }
  await applyPlan(student, { keep, create, end: unmatched, desiredFor: (p) => matched.get(p.id) || null });
}

async function add(q, specs) {
  const wanted = parseSpecs(specs);
  const student = await resolveStudent(q);
  const create = [];
  for (const w of wanted) {
    const dupe = await findActiveDuplicatePlan(student.sheetId, w);
    if (dupe && !flags['allow-duplicate']) {
      die(`${student.name} already has an active ${formatSession(w)} [${short(dupe.id)}]. Adding another lets them book it twice a week — label it differently, or pass --allow-duplicate if that's intended.`, 2);
    }
    create.push(w);
  }
  await applyPlan(student, { keep: [], create, end: [] });
}

async function end(q, targets) {
  if (!targets.length) die('Which session? Give specs (teacher/minutes/label) or plan ids.', 2);
  const student = await resolveStudent(q);
  const current = await loadProjectPlans(student.sheetId);
  const toEnd = [];
  for (const t of targets) {
    // An id must be ≥ 6 hex chars (a bare "" or "a" would otherwise prefix-match the
    // first plan), and a prefix must be unique.
    if (/^[0-9a-f-]{6,}$/i.test(t)) {
      const byId = current.filter((p) => p.id === t || p.id.startsWith(t.toLowerCase()));
      if (byId.length > 1) die(`“${t}” matches ${byId.length} active plans — give more of the id: ${byId.map((p) => p.id).join(', ')}`, 2);
      if (byId.length === 1) { toEnd.push(byId[0]); continue; }
    }
    const v = parseSessionSpec(t);
    if (!v.ok) die(`“${t}” is neither an active plan id nor a valid spec: ${v.error}`, 2);
    const m = current.filter((p) => sameSession(p, v.value));
    if (!m.length) die(`${student.name} has no active ${formatSession(v.value)}. Active: ${current.map(fmtPlan).join('; ') || 'none'}`, 2);
    if (m.length > 1) die(`${student.name} has ${m.length} active ${formatSession(v.value)} plans — end by id: ${m.map((p) => p.id).join(', ')}`, 2);
    toEnd.push(m[0]);
  }
  await applyPlan(student, { keep: current.filter((p) => !toEnd.includes(p)), create: [], end: toEnd });
}

// ── go ───────────────────────────────────────────────────────────────────────
try {
  if (cmd === 'show') await show(rest[0]);
  else if (cmd === 'list') await list();
  else if (cmd === 'set') await set(rest[0], rest.slice(1));
  else if (cmd === 'add') await add(rest[0], rest.slice(1));
  else if (cmd === 'end') await end(rest[0], rest.slice(1));
} catch (e) {
  die(e?.message || String(e));
}
