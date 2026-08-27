/**
 * backfillBookings.cjs — Google Calendar → Supabase `bookings` (standard/ART record).
 *
 *   node scripts/backfillBookings.cjs --dry-run                 # DEFAULT: report only, no writes
 *   node scripts/backfillBookings.cjs --dry-run --since 2026-01-01 --until 2026-10-31
 *   node scripts/backfillBookings.cjs --write                   # INSERT … ON CONFLICT (calendar_event_id) DO NOTHING
 *   node scripts/backfillBookings.cjs --dry-run --verbose       # one line per event with its verdict
 *
 * Package C of the zero-Google sweep (2026-08-27). Best-effort, NOT a gate (ruling
 * (b): information loss is acceptable and repaired ad hoc). Re-runnable: the
 * unique constraint on calendar_event_id + ignoreDuplicates makes every run idempotent.
 *
 * What it lists: timed events on the two instructor calendars
 * (GOOGLE_CALENDAR_ID_AARON / _RYAN, read with the service account) in the window.
 *
 * Which events qualify (review F9 + the FINAL sheet):
 *   • created by the service account (portal bookings) — matched by provenance
 *     (extendedProperties.private.studentEmail → students.student_email), falling
 *     back to the title;
 *   • created by Aaron's personal account (aaronblumenthal21@gmail.com) ONLY when the
 *     title matches the portal pattern  `{ART: }{Name} – {N}min{: agenda}`;
 *   • any other creator is SKIPPED and counted (reported, never guessed).
 *   • events whose id is already claimed by project_meeting_bookings or
 *     senior_bookings (their own ledgers), or whose provenance says
 *     bookingType senior/project, are skipped — this table is standard/ART only.
 *   • parent-meeting titles (lib/calendarTitles rule: \bparents?\b) are skipped.
 *
 * Matching by NAME is exact on the normalized full name (lowercase, letters only).
 * Two students sharing a normalized name → AMBIGUOUS: reported, never inserted.
 * No student → UNMATCHED: reported. Neither is ever fuzzy-matched (F9).
 *
 * Accepted loss, stated: events on Aaron's/Ryan's calendars created by anyone else,
 * or titled outside the pattern, are absent from `bookings` until reconciled by hand.
 *
 * Requires: supabase/bookings.sql applied (a --write against a missing table fails
 * loudly; --dry-run does not touch the table at all except to read existing ids).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const ZONE = 'America/Los_Angeles';
const AARON_PERSONAL = 'aaronblumenthal21@gmail.com';

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
}
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const normEmail = (s) => String(s || '').trim().toLowerCase();
const PARENT_TITLE = /\bparents?\b/i;
// "{ART: }{Name} – {N}min{: agenda}" — the exact shape bookMeeting writes.
const TITLE = /^(ART:\s*)?(.+?)\s+[–-]\s+(\d+)\s*min(?:\s*:\s*(.*))?$/;

async function main() {
  const WRITE = process.argv.includes('--write');
  const VERBOSE = process.argv.includes('--verbose');
  if (WRITE && process.argv.includes('--dry-run')) throw new Error('pick one: --write or --dry-run');
  const get = loadEnv();
  const SA_EMAIL = normEmail(get('GOOGLE_SERVICE_ACCOUNT_EMAIL'));
  const CALS = { aaron: get('GOOGLE_CALENDAR_ID_AARON'), ryan: get('GOOGLE_CALENDAR_ID_RYAN') };
  const since = DateTime.fromISO(arg('--since', '2026-01-01'), { zone: ZONE }).startOf('day');
  const until = DateTime.fromISO(arg('--until', DateTime.now().setZone(ZONE).plus({ weeks: 8 }).toISODate()), { zone: ZONE }).endOf('day');

  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'), private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  const calendar = google.calendar({ version: 'v3', auth });
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  // ── Roster + the other ledgers' claims ──────────────────────────────────
  const { data: students, error: sErr } = await sb.from('students').select('student_sheet_id, id, name, student_email');
  if (sErr) throw sErr;
  const byEmail = new Map();
  const byName = new Map(); // normalized name → [students]
  for (const s of students) {
    if (s.student_email) byEmail.set(normEmail(s.student_email), s);
    const n = norm(s.name);
    if (n) byName.set(n, [...(byName.get(n) || []), s]);
  }
  const claimed = new Set();
  for (const t of ['project_meeting_bookings', 'senior_bookings']) {
    const { data, error } = await sb.from(t).select('calendar_event_id');
    if (error) throw error;
    for (const r of data) if (r.calendar_event_id) claimed.add(r.calendar_event_id);
  }
  let existing = new Set();
  {
    const { data, error } = await sb.from('bookings').select('calendar_event_id');
    if (error) {
      if (WRITE) throw error;
      console.warn(`bookings table not readable (${error.message}) — assuming empty (dry-run only)`);
    } else existing = new Set(data.map((r) => r.calendar_event_id).filter(Boolean));
  }

  // ── Calendar listing ────────────────────────────────────────────────────
  async function listAll(calendarId) {
    const out = [];
    let pageToken;
    do {
      const res = await calendar.events.list({
        calendarId, timeMin: since.toISO(), timeMax: until.toISO(),
        singleEvents: true, orderBy: 'startTime', maxResults: 2500, pageToken,
      });
      out.push(...(res.data.items || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return out;
  }

  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const rows = [];
  const ambiguous = [];
  const unmatched = [];
  const otherCreators = {};

  for (const instructor of ['aaron', 'ryan']) {
    const calendarId = CALS[instructor];
    if (!calendarId) { console.warn(`no calendar id for ${instructor}`); continue; }
    const events = await listAll(calendarId);
    for (const e of events) {
      const say = (verdict, extra = '') => { bump(verdict); if (VERBOSE) console.log(`  [${verdict}] ${instructor} ${e.start?.dateTime || e.start?.date} ${JSON.stringify(e.summary || '')} ${extra}`); };
      if (e.status === 'cancelled') { say('skip:cancelled'); continue; }
      if (!e.start?.dateTime) { say('skip:all-day'); continue; }
      if (!e.summary) { say('skip:untitled'); continue; }
      if (claimed.has(e.id)) { say('skip:claimed-by-other-ledger'); continue; }
      if (existing.has(e.id)) { say('skip:already-in-bookings'); continue; }
      if (PARENT_TITLE.test(e.summary)) { say('skip:parent-meeting'); continue; }
      const pep = e.extendedProperties?.private || {};
      if (pep.bookingType === 'senior' || pep.bookingType === 'project') { say(`skip:provenance-${pep.bookingType}`); continue; }

      const creator = normEmail(e.creator?.email);
      const m = String(e.summary).match(TITLE);
      const fromSA = creator === SA_EMAIL || pep.source === 'student-portal';
      if (!fromSA) {
        if (creator !== AARON_PERSONAL || !m) {
          otherCreators[creator || '(none)'] = (otherCreators[creator || '(none)'] || 0) + 1;
          say('skip:other-creator-or-pattern', `creator=${creator}`);
          continue;
        }
      }

      // Match: provenance email first, then exact normalized name from the title.
      let student = pep.studentEmail ? byEmail.get(normEmail(pep.studentEmail)) : null;
      let how = student ? 'email' : null;
      if (!student && m) {
        const cands = byName.get(norm(m[2])) || [];
        if (cands.length === 1) { student = cands[0]; how = 'name'; }
        else if (cands.length > 1) { ambiguous.push({ id: e.id, instructor, when: e.start.dateTime, title: e.summary, candidates: cands.map((c) => `${c.name} <${c.student_email}>`) }); say('ambiguous'); continue; }
      }
      if (!student) { unmatched.push({ id: e.id, instructor, when: e.start.dateTime, title: e.summary, creator }); say('unmatched'); continue; }

      const start = DateTime.fromISO(e.start.dateTime).setZone(ZONE);
      const end = DateTime.fromISO(e.end.dateTime).setZone(ZONE);
      const isArt = pep.bookingType === 'art' || /^ART:/.test(e.summary);
      const minutes = m ? parseInt(m[3], 10) : Math.round(end.diff(start, 'minutes').minutes);
      rows.push({
        student_sheet_id: student.student_sheet_id,
        student_id: student.id || null,
        student_email: normEmail(pep.studentEmail) || normEmail(student.student_email) || null,
        instructor,
        track: isArt ? 'art' : 'standard',
        calendar_id: calendarId,
        calendar_event_id: e.id,
        meeting_date: start.toISODate(),
        start_time: start.toUTC().toISO(),
        end_time: end.toUTC().toISO(),
        minutes,
        agenda: (m && m[4] ? m[4].trim() : null) || null,
        status: 'active',
        source: 'backfill',
      });
      say(`insert:${how}`, `→ ${student.name}`);
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  console.log(`\nbackfillBookings ${WRITE ? '--write' : '--dry-run'}  window ${since.toISODate()} → ${until.toISODate()}`);
  console.log('verdicts:', JSON.stringify(counts, null, 0));
  console.log(`rows to insert: ${rows.length}  (by track: ${JSON.stringify(rows.reduce((a, r) => ((a[r.track] = (a[r.track] || 0) + 1), a), {}))}, by instructor: ${JSON.stringify(rows.reduce((a, r) => ((a[r.instructor] = (a[r.instructor] || 0) + 1), a), {}))})`);
  if (Object.keys(otherCreators).length) console.log('skipped by creator (not SA, not aaronblumenthal21+pattern):', JSON.stringify(otherCreators));
  console.log(`ambiguous names: ${ambiguous.length}`);
  for (const a of ambiguous) console.log(`  ${a.when} [${a.instructor}] ${JSON.stringify(a.title)} → ${a.candidates.join(' | ')}`);
  console.log(`unmatched events: ${unmatched.length}`);
  for (const u of unmatched) console.log(`  ${u.when} [${u.instructor}] ${JSON.stringify(u.title)} creator=${u.creator}`);

  if (!WRITE) { console.log('\n(dry-run: nothing written)'); return; }
  if (!rows.length) { console.log('nothing to write'); return; }
  // INSERT … ON CONFLICT (calendar_event_id) DO NOTHING
  const { data, error } = await sb.from('bookings').upsert(rows, { onConflict: 'calendar_event_id', ignoreDuplicates: true }).select('id');
  if (error) throw error;
  console.log(`inserted ${(data || []).length} (duplicates ignored: ${rows.length - (data || []).length})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
