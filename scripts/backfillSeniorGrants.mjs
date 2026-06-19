/**
 * backfillSeniorGrants.mjs — ONE-TIME cutover for the senior check-in token ledger.
 *
 *   node scripts/backfillSeniorGrants.mjs            # DRY RUN (resolve + print)
 *   node scripts/backfillSeniorGrants.mjs --write    # write grants + bookings
 *
 * For each active senior, create the GRANT implied by their most recent Master
 * check-in (AY col 50) — but only if that grant's window still covers today — and
 * record their existing FUTURE senior calendar meetings as consumption rows so the
 * new ledger-based authorization matches reality (no over-booking, no lockout).
 * Existing calendar events are left untouched. Read-only vs Google; writes only to
 * Supabase. Idempotent: skips a grant that already exists for the senior's check-in
 * week; upserts bookings on calendar_event_id.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import {
  ZONE,
  startOfSaturdayWeek,
  grantWindow,
  PACKAGE_RULES,
  parseSheetDate,
} from '../lib/seniorsCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = "'👩‍🎓 All Data'";

function loadEnv() {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return (k) => {
    const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
  };
}

async function main() {
  const WRITE = process.argv.includes('--write');
  const get = loadEnv();
  const sb = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: get('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      private_key: get('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    },
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const calendar = google.calendar({ version: 'v3', auth });
  const CAL = { aaron: get('GOOGLE_CALENDAR_ID_AARON'), ryan: get('GOOGLE_CALENDAR_ID_RYAN') };

  const today = DateTime.now().setZone(ZONE).toISODate();

  // Seniors + their Master AY (last check-in), keyed by email.
  const { data: seniors, error } = await sb.from('seniors').select('*').eq('active', true);
  if (error) throw error;
  const master =
    (
      await sheets.spreadsheets.values.get({
        spreadsheetId: MASTER_SHEET_ID,
        range: `${MASTER_TAB}!A:AY`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
    ).data.values || [];
  const ayByEmail = {};
  for (const r of master) {
    const em = String(r[9] || '').trim().toLowerCase();
    if (em) ayByEmail[em] = r[50];
  }

  const windowStart = DateTime.now().setZone(ZONE).startOf('day');
  const windowEnd = windowStart.plus({ weeks: 5 });

  let grantsMade = 0;
  let bookingsMade = 0;
  for (const s of seniors) {
    const ay = ayByEmail[String(s.student_email || '').toLowerCase()];
    const ayDt = parseSheetDate(ay);
    if (!ayDt) {
      console.log(`  – ${s.student_name.padEnd(22)} no check-in on record — skipping (will re-check-in)`);
      continue;
    }
    const win = grantWindow(ayDt);
    if (win.validThrough.toISODate() < today) {
      console.log(`  – ${s.student_name.padEnd(22)} last check-in too old (grant expired ${win.validThrough.toISODate()}) — skipping`);
      continue;
    }
    const isEssential = s.package === 'essential';
    const rule = PACKAGE_RULES[s.package];
    const weekStartISO = win.weekStart.toISODate();

    // Idempotent grant: reuse an existing active grant for this check-in week.
    let grant = null;
    const { data: existing } = await sb
      .from('senior_checkin_grants')
      .select('*')
      .eq('student_sheet_id', s.student_sheet_id)
      .eq('active', true)
      .eq('week_start', weekStartISO)
      .maybeSingle();
    if (existing) {
      grant = existing;
    } else if (WRITE) {
      await sb
        .from('senior_checkin_grants')
        .update({ active: false })
        .eq('student_sheet_id', s.student_sheet_id)
        .eq('active', true);
      const { data, error: gErr } = await sb
        .from('senior_checkin_grants')
        .insert({
          student_sheet_id: s.student_sheet_id,
          student_email: s.student_email,
          granted_at: ayDt.toISO(),
          week_start: weekStartISO,
          valid_through: win.validThrough.toISODate(),
          package: s.package,
          meeting_tokens: isEssential ? 0 : rule.maxPerWeek,
          budget_minutes: isEssential ? rule.budgetMin : null,
        })
        .select()
        .single();
      if (gErr) throw gErr;
      grant = data;
      grantsMade++;
    }

    // Future senior meetings on either calendar → consumption rows.
    const emailLc = String(s.student_email || '').toLowerCase();
    const nameLc = String(s.student_name || '').toLowerCase().trim();
    const future = [];
    for (const slug of ['aaron', 'ryan']) {
      if (!CAL[slug]) continue;
      let items = [];
      try {
        items = (
          await calendar.events.list({
            calendarId: CAL[slug],
            timeMin: windowStart.toISO(),
            timeMax: windowEnd.toISO(),
            singleEvents: true,
            orderBy: 'startTime',
          })
        ).data.items || [];
      } catch { /* ignore */ }
      for (const e of items) {
        if (e.status === 'cancelled') continue;
        const pep = e.extendedProperties?.private || {};
        // ONLY real senior-portal bookings cash tokens. Manual team holds (no
        // extendedProperties) and standard/underclassman bookings stay off-ledger.
        const isSeniorPortal = pep.source === 'student-portal' && pep.bookingType === 'senior';
        const mine =
          isSeniorPortal &&
          ((pep.studentEmail && pep.studentEmail.toLowerCase() === emailLc) ||
            (!pep.studentEmail && nameLc && e.summary && e.summary.toLowerCase().includes(nameLc)));
        if (!mine) continue;
        const start = DateTime.fromISO(e.start?.dateTime || e.start?.date).setZone(ZONE);
        const end = DateTime.fromISO(e.end?.dateTime || e.end?.date).setZone(ZONE);
        // Prefer the booked length (extendedProperties.type, e.g. "30min") over the
        // calendar span, which can drift if an event was hand-edited.
        const minutes =
          parseInt(String(pep.type || '').replace(/\D/g, ''), 10) ||
          (start.isValid && end.isValid ? Math.round(end.diff(start, 'minutes').minutes) : 30);
        future.push({ slug, eventId: e.id, date: start.toISODate(), minutes });
      }
    }

    const flags = future
      .map((m) => `${m.date}/${m.slug}/${m.minutes}m${m.date > win.validThrough.toISODate() ? ' (out-of-window, grandfathered)' : ''}`)
      .join(', ');
    console.log(
      `  ✓ ${s.student_name.padEnd(22)} ${s.package.padEnd(13)} grant ${weekStartISO}→${win.validThrough.toISODate()}  ${future.length} mtg(s)${flags ? ': ' + flags : ''}`
    );

    if (WRITE && grant && future.length) {
      for (const m of future) {
        const { error: bErr } = await sb.from('senior_bookings').upsert(
          {
            grant_id: grant.id,
            student_sheet_id: s.student_sheet_id,
            calendar_event_id: m.eventId,
            teacher: m.slug,
            meeting_date: m.date,
            minutes: m.minutes,
            status: 'active',
          },
          { onConflict: 'calendar_event_id' }
        );
        if (bErr) throw bErr;
        bookingsMade++;
      }
    }
  }

  console.log(`\n${WRITE ? 'WROTE' : 'DRY RUN'} — ${grantsMade} grant(s), ${bookingsMade} booking(s).`);
  if (!WRITE) console.log('Re-run with --write to persist.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
