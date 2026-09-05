/**
 * cancelNextBooking.mjs — remove the booking made from a /next/<slug> page.
 *
 *   node scripts/cancelNextBooking.mjs aaron            # dry run: says what it would delete
 *   node scripts/cancelNextBooking.mjs aaron --commit   # delete it and clear the row
 *
 * Deletes the event from Ryan's calendar with sendUpdates 'all', so the family
 * (or, for a rehearsal, Aaron) gets a real cancellation rather than a meeting
 * that quietly disappears from one calendar and stays on the other. Then clears
 * booked_event_id / booked_start / booked_at and the `booked` key inside `data`,
 * which is what puts the page back to offering times.
 *
 * Written for the 2026-09-03 rehearsal: Aaron books /next/aaron, sees the event
 * land on Ryan's real calendar and the invitation land in his own inbox, and
 * then this takes it back off so Ryan never wonders what it was.
 *
 * Dry run by default. Deleting a real family's meeting is not something a
 * mistyped argument should be able to do.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLE = 'lead_pages';
const LEADS_DIR = path.join(__dirname, '..', 'app', 'next', 'leads');

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const slug = args.find((a) => !a.startsWith('--'));
if (!slug) {
  console.error('Usage: node scripts/cancelNextBooking.mjs <slug> [--commit]');
  process.exit(1);
}

const get = loadEnv();
const calendarId = get('GOOGLE_CALENDAR_ID_RYAN');
const url = get('SUPABASE_URL');
const key = get('SUPABASE_SERVICE_ROLE_KEY');

/* The booking may live on the row (production) or, while the table does not yet
   exist, only in the local file the dev fallback reads. Both are checked so the
   script is useful tonight and correct later. */
let booking = null;
let source = null;
let sb = null;

if (url && key) {
  sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb
    .from(TABLE)
    .select('data, booked_event_id, booked_start')
    .eq('slug', slug)
    .maybeSingle();
  if (!error && data) {
    source = 'lead_pages row';
    booking = data.data?.booked || (data.booked_event_id ? { event_id: data.booked_event_id, start: data.booked_start } : null);
  }
}

if (!booking) {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(LEADS_DIR, `${slug}.json`), 'utf8'));
    if (file.booked) {
      source = `app/next/leads/${slug}.json`;
      booking = file.booked;
    }
  } catch {
    /* No local file is fine; the row may simply not be booked. */
  }
}

if (!booking?.event_id) {
  console.log(`No booking recorded for "${slug}". Nothing to cancel.`);
  process.exit(0);
}

console.log(`slug        : ${slug}`);
console.log(`source      : ${source}`);
console.log(`event id    : ${booking.event_id}`);
console.log(`start       : ${booking.start}`);
console.log(`calendar    : ${calendarId}`);

if (!commit) {
  console.log('\nDry run. Nothing was deleted. Re-run with --commit.');
  process.exit(0);
}

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    private_key: get('GOOGLE_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

try {
  await calendar.events.delete({ calendarId, eventId: booking.event_id, sendUpdates: 'all' });
  console.log('deleted the calendar event (no attendees to notify; see app/api/next/book/route.js)');
} catch (err) {
  /* 410 means Google already considers it gone. That is the desired end state,
     so the row still gets cleared rather than left pointing at nothing. */
  const code = err?.code || err?.response?.status;
  if (code === 410 || code === 404) console.log(`event was already gone (${code}); clearing the row anyway`);
  else {
    console.error('calendar delete failed:', err.message);
    process.exit(1);
  }
}

if (sb) {
  const { data } = await sb.from(TABLE).select('data').eq('slug', slug).maybeSingle();
  if (data) {
    const next = { ...data.data };
    delete next.booked;
    const { error } = await sb
      .from(TABLE)
      .update({ data: next, booked_event_id: null, booked_start: null, booked_at: null, updated_at: new Date().toISOString() })
      .eq('slug', slug);
    if (error) {
      console.error('row clear failed:', error.message);
      process.exit(1);
    }
    console.log('cleared booked_event_id / booked_start / booked_at and data.booked');
  }
}

/* The local file is cleared too, or the dev fallback would keep rendering a
   booking that no longer exists on any calendar. */
try {
  const file = path.join(LEADS_DIR, `${slug}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.booked) {
    delete parsed.booked;
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n');
    console.log(`cleared booked from app/next/leads/${slug}.json`);
  }
} catch {
  /* No local file, nothing to clear. */
}

console.log('\nThe page is back to offering times.');
