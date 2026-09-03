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
 * This is the ONE-TIME historical sweep over a wide window. The scan itself, and every
 * rule about which events qualify and how they match a student, live in
 * scripts/lib/bookingDiscovery.cjs — shared with scripts/reconcileBookings.cjs, whose
 * rolling discovery pass asks the identical question over a rolling window. Read that
 * module's header for the qualification and matching rules.
 *
 * Requires: supabase/bookings.sql applied (a --write against a missing table fails
 * loudly; --dry-run does not touch the table at all except to read existing ids).
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');
const { ZONE, discoverBookings, printDiscoveryReport } = require('./lib/bookingDiscovery.cjs');

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].replace(/^['"]|['"]$/g, '') : null; };
}
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };

async function main() {
  const WRITE = process.argv.includes('--write');
  const VERBOSE = process.argv.includes('--verbose');
  if (WRITE && process.argv.includes('--dry-run')) throw new Error('pick one: --write or --dry-run');
  const get = loadEnv();
  const CALS = { aaron: get('GOOGLE_CALENDAR_ID_AARON'), ryan: get('GOOGLE_CALENDAR_ID_RYAN') };
  const since = DateTime.fromISO(arg('--since', '2026-01-01'), { zone: ZONE }).startOf('day');
  const until = DateTime.fromISO(arg('--until', DateTime.now().setZone(ZONE).plus({ weeks: 8 }).toISODate()), { zone: ZONE }).endOf('day');

  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'), private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n') },
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  const calendar = google.calendar({ version: 'v3', auth });
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const found = await discoverBookings({
    calendar, sb, cals: CALS, saEmail: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    since, until, verbose: VERBOSE, source: 'backfill', requireBookingsTable: WRITE,
  });

  printDiscoveryReport(
    `backfillBookings ${WRITE ? '--write' : '--dry-run'}  window ${since.toISODate()} → ${until.toISODate()}`,
    found
  );

  if (!WRITE) { console.log('\n(dry-run: nothing written)'); return; }
  if (!found.rows.length) { console.log('nothing to write'); return; }
  // INSERT … ON CONFLICT (calendar_event_id) DO NOTHING
  const { data, error } = await sb.from('bookings').upsert(found.rows, { onConflict: 'calendar_event_id', ignoreDuplicates: true }).select('id');
  if (error) throw error;
  console.log(`inserted ${(data || []).length} (duplicates ignored: ${found.rows.length - (data || []).length})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
