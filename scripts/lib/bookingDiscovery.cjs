/**
 * bookingDiscovery.cjs — the ONE Calendar → Supabase `bookings` discovery pass.
 *
 * Two scripts need the identical question answered ("which timed events on the two
 * instructor calendars are standard/ART meetings with no `bookings` row?"):
 *   • scripts/backfillBookings.cjs — the one-time historical sweep (Package C).
 *   • scripts/reconcileBookings.cjs — the rolling pass, which without it could only
 *     ever see meetings that already had a row, so a meeting Aaron or Ryan created by
 *     hand on the calendar (an anticipated case — supabase/bookings.sql:20) stayed
 *     invisible to the student forever.
 * They share this module rather than each carrying a copy, so the matching rules can
 * never drift into two answers about the same event.
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
 */
const { DateTime } = require('luxon');

const ZONE = 'America/Los_Angeles';
const AARON_PERSONAL = 'aaronblumenthal21@gmail.com';
const PARENT_TITLE = /\bparents?\b/i;
// "{ART: }{Name} – {N}min{: agenda}" — the exact shape bookMeeting writes.
const TITLE = /^(ART:\s*)?(.+?)\s+[–-]\s+(\d+)\s*min(?:\s*:\s*(.*))?$/;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const normEmail = (s) => String(s || '').trim().toLowerCase();

async function listAll(calendar, calendarId, since, until) {
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

/**
 * @param {object}  o
 * @param {object}  o.calendar   googleapis calendar client
 * @param {object}  o.sb         supabase client (service role)
 * @param {object}  o.cals       { aaron, ryan } calendar ids
 * @param {string}  o.saEmail    the service-account email
 * @param {DateTime} o.since     window start (LA)
 * @param {DateTime} o.until     window end (LA)
 * @param {boolean} o.verbose    one line per event with its verdict
 * @param {string}  o.source     stamped on every produced row ('backfill' | 'reconcile')
 * @param {boolean} o.requireBookingsTable  throw instead of warning when `bookings` is unreadable
 * @returns {Promise<{rows, ambiguous, unmatched, counts, otherCreators}>}
 */
async function discoverBookings({
  calendar, sb, cals, saEmail, since, until, verbose = false, source = 'backfill',
  requireBookingsTable = false,
}) {
  const SA_EMAIL = normEmail(saEmail);

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
      if (requireBookingsTable) throw error;
      console.warn(`bookings table not readable (${error.message}) — assuming empty (dry-run only)`);
    } else existing = new Set(data.map((r) => r.calendar_event_id).filter(Boolean));
  }

  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const rows = [];
  const ambiguous = [];
  const unmatched = [];
  const otherCreators = {};

  for (const instructor of ['aaron', 'ryan']) {
    const calendarId = cals[instructor];
    if (!calendarId) { console.warn(`no calendar id for ${instructor}`); continue; }
    const events = await listAll(calendar, calendarId, since, until);
    for (const e of events) {
      const say = (verdict, extra = '') => { bump(verdict); if (verbose) console.log(`  [${verdict}] ${instructor} ${e.start?.dateTime || e.start?.date} ${JSON.stringify(e.summary || '')} ${extra}`); };
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
        source,
      });
      say(`insert:${how}`, `→ ${student.name}`);
    }
  }

  return { rows, ambiguous, unmatched, counts, otherCreators };
}

// Ambiguous and unmatched events are PRINTED, never inserted — the whole point of
// the pass is that a guess is worse than a gap a human can see.
function printDiscoveryReport(label, { rows, ambiguous, unmatched, counts, otherCreators }) {
  console.log(`\n${label}`);
  console.log('verdicts:', JSON.stringify(counts, null, 0));
  console.log(`rows to insert: ${rows.length}  (by track: ${JSON.stringify(rows.reduce((a, r) => ((a[r.track] = (a[r.track] || 0) + 1), a), {}))}, by instructor: ${JSON.stringify(rows.reduce((a, r) => ((a[r.instructor] = (a[r.instructor] || 0) + 1), a), {}))})`);
  if (Object.keys(otherCreators).length) console.log('skipped by creator (not SA, not aaronblumenthal21+pattern):', JSON.stringify(otherCreators));
  console.log(`ambiguous names: ${ambiguous.length}`);
  for (const a of ambiguous) console.log(`  ${a.when} [${a.instructor}] ${JSON.stringify(a.title)} → ${a.candidates.join(' | ')}`);
  console.log(`unmatched events: ${unmatched.length}`);
  for (const u of unmatched) console.log(`  ${u.when} [${u.instructor}] ${JSON.stringify(u.title)} creator=${u.creator}`);
}

module.exports = {
  ZONE, AARON_PERSONAL, PARENT_TITLE, TITLE,
  norm, normEmail, listAll, discoverBookings, printDiscoveryReport,
};
