/**
 * reconcileBookings.cjs — Google Calendar → Supabase `bookings` (the reconcile direction).
 *
 *   node scripts/reconcileBookings.cjs --dry-run              # DEFAULT: report the diff, no writes
 *   node scripts/reconcileBookings.cjs --write                # apply time changes + hand-deletions to `bookings`
 *   node scripts/reconcileBookings.cjs --write --push-pending # ALSO create events for rows whose calendar sync is pending
 *
 * Why this exists (review F9 / plan §2 amendment): Aaron hand-edits events outside
 * the portal — drags them to a new time, deletes them. Without a Calendar→Postgres
 * pass, `bookings` drifts exactly as project_meeting_bookings did. This script is
 * that pass, for the `bookings` ledger ONLY (the senior/project ledgers keep their
 * own reschedule/cancel routes).
 *
 * For every ACTIVE `bookings` row:
 *   • calendar_event_id set → events.get by id.
 *       - 404/410 or status 'cancelled' → row becomes status 'cancelled' (cancelled_at = now).
 *       - start/end differ from the row  → row's start_time / end_time / meeting_date /
 *         minutes follow the event (the calendar is the surface Aaron edits).
 *       - otherwise                       → in sync.
 *   • calendar_event_id NULL → "calendar sync pending" (Calendar was down when the
 *     portal booked). Always LISTED — this is the waiting set the ⛔ rule in
 *     .claude/CLAUDE.md says must be enumerable. With --write --push-pending the event
 *     is created (same extendedProperties bookMeeting writes) and attached. A pending
 *     row whose meeting is already in the past is listed as 'stale-pending' and left
 *     for a human.
 *
 * Every applied change stamps source='reconcile' on the row it touched, so a later
 * reader can tell a hand-edit from a portal write.
 *
 * Cadence suggestion: hourly on the NAS alongside scripts/reconcile.cjs (NOT wired
 * there by this package — a cron entry is a deploy decision).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const ZONE = 'America/Los_Angeles';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
}
const isGone = (err) => { const c = err?.code || err?.response?.status; return c === 404 || c === 410; };
const sameInstant = (a, b) => DateTime.fromISO(a).toMillis() === DateTime.fromISO(b).toMillis();

async function main() {
  const WRITE = process.argv.includes('--write');
  const PUSH = process.argv.includes('--push-pending');
  if (WRITE && process.argv.includes('--dry-run')) throw new Error('pick one: --write or --dry-run');
  const get = loadEnv();
  const CALS = { aaron: get('GOOGLE_CALENDAR_ID_AARON'), ryan: get('GOOGLE_CALENDAR_ID_RYAN') };
  const ZOOM = { aaron: 'https://us02web.zoom.us/j/3200479217', ryan: 'https://us02web.zoom.us/j/8846768033' };

  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'), private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n') },
    scopes: [WRITE && PUSH ? 'https://www.googleapis.com/auth/calendar' : 'https://www.googleapis.com/auth/calendar.readonly'],
  });
  const calendar = google.calendar({ version: 'v3', auth });
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const { data: rows, error } = await sb.from('bookings').select('*').eq('status', 'active').order('meeting_date');
  if (error) throw new Error(`bookings read failed (table applied?): ${error.message}`);

  const now = DateTime.now().setZone(ZONE);
  const report = { inSync: 0, moved: [], deleted: [], pending: [], stalePending: [], errors: [] };
  const updates = []; // [{ id, patch }]

  for (const r of rows) {
    const calendarId = r.calendar_id || CALS[r.instructor];
    if (!r.calendar_event_id) {
      (DateTime.fromISO(r.end_time) < now ? report.stalePending : report.pending).push(r);
      continue;
    }
    let ev;
    try {
      ev = (await calendar.events.get({ calendarId, eventId: r.calendar_event_id })).data;
    } catch (e) {
      if (isGone(e)) ev = null;
      else { report.errors.push({ id: r.id, event: r.calendar_event_id, error: e?.message || String(e) }); continue; }
    }
    if (!ev || ev.status === 'cancelled') {
      report.deleted.push(r);
      updates.push({ id: r.id, patch: { status: 'cancelled', cancelled_at: now.toUTC().toISO(), source: 'reconcile', updated_at: now.toUTC().toISO() } });
      continue;
    }
    const evStart = ev.start?.dateTime;
    const evEnd = ev.end?.dateTime;
    if (!evStart || !evEnd) { report.errors.push({ id: r.id, event: r.calendar_event_id, error: 'event became all-day; not reconciled' }); continue; }
    if (sameInstant(evStart, r.start_time) && sameInstant(evEnd, r.end_time)) { report.inSync++; continue; }
    const s = DateTime.fromISO(evStart).setZone(ZONE);
    const e2 = DateTime.fromISO(evEnd).setZone(ZONE);
    report.moved.push({ row: r, from: `${r.start_time} → ${r.end_time}`, to: `${s.toUTC().toISO()} → ${e2.toUTC().toISO()}` });
    updates.push({ id: r.id, patch: {
      start_time: s.toUTC().toISO(), end_time: e2.toUTC().toISO(), meeting_date: s.toISODate(),
      minutes: Math.round(e2.diff(s, 'minutes').minutes), source: 'reconcile', updated_at: now.toUTC().toISO(),
    } });
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const who = (r) => `${r.meeting_date} ${r.instructor}/${r.track} ${r.student_email || r.student_sheet_id} (${r.minutes}min)`;
  console.log(`\nreconcileBookings ${WRITE ? '--write' : '--dry-run'}${PUSH ? ' --push-pending' : ''}  active rows: ${rows.length}`);
  console.log(`in sync: ${report.inSync}`);
  console.log(`moved on Calendar (row follows): ${report.moved.length}`);
  for (const m of report.moved) console.log(`  ${who(m.row)}  ${m.from}  ⇒  ${m.to}`);
  console.log(`deleted on Calendar (row → cancelled): ${report.deleted.length}`);
  for (const d of report.deleted) console.log(`  ${who(d)} event=${d.calendar_event_id}`);
  console.log(`calendar sync PENDING (no event yet): ${report.pending.length}`);
  for (const p of report.pending) console.log(`  ${who(p)} booking=${p.id}`);
  console.log(`stale pending (meeting already past, needs a human): ${report.stalePending.length}`);
  for (const p of report.stalePending) console.log(`  ${who(p)} booking=${p.id}`);
  console.log(`errors: ${report.errors.length}`);
  for (const e of report.errors) console.log(`  booking=${e.id} event=${e.event} ${e.error}`);

  if (!WRITE) { console.log('\n(dry-run: nothing written)'); return; }

  for (const u of updates) {
    const { error: uErr } = await sb.from('bookings').update(u.patch).eq('id', u.id).eq('status', 'active');
    if (uErr) console.error(`update failed for ${u.id}:`, uErr.message);
  }
  console.log(`applied ${updates.length} row update(s)`);

  if (!PUSH) return;
  for (const p of report.pending) {
    const calendarId = p.calendar_id || CALS[p.instructor];
    const { data: student } = await sb.from('students').select('name').eq('student_sheet_id', p.student_sheet_id).maybeSingle();
    const name = String(student?.name || '').trim() || p.student_email || 'Student';
    const prefix = p.track === 'art' ? 'ART: ' : '';
    const summary = p.agenda ? `${prefix}${name} – ${p.minutes}min: ${p.agenda}` : `${prefix}${name} – ${p.minutes}min`;
    const description = p.agenda ? `Zoom: ${ZOOM[p.instructor]}\nAgenda: ${p.agenda}` : `Zoom: ${ZOOM[p.instructor]}`;
    try {
      const res = await calendar.events.insert({
        calendarId,
        requestBody: {
          summary, description,
          start: { dateTime: p.start_time, timeZone: ZONE },
          end: { dateTime: p.end_time, timeZone: ZONE },
          extendedProperties: { private: {
            source: 'student-portal', studentEmail: p.student_email || '', type: `${p.minutes}min`,
            instructor: p.track === 'art' ? 'art' : p.instructor, bookingType: p.track, bookingId: p.id,
          } },
        },
      });
      const { error: aErr } = await sb.from('bookings').update({ calendar_event_id: res.data.id, calendar_id: calendarId, source: 'reconcile', updated_at: now.toUTC().toISO() }).eq('id', p.id);
      if (aErr) console.error(`event ${res.data.id} created but not attached to ${p.id}:`, aErr.message);
      else console.log(`pushed ${who(p)} → event ${res.data.id}`);
    } catch (e) {
      console.error(`push failed for ${p.id}:`, e?.message || e);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
