import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { requireDeveloper } from '@/lib/developerAuth';

// Engagement status per student per instructor, mirroring the logic in
// "Google Apps Scripts/checkinReminder.gs" (the automated Friday reminder):
// engaged = check-in within the window OR a meeting within the window OR an
// upcoming meeting on file. Sources both tabs — the old version only read the
// master sheet's check-in columns, so students with recent/upcoming meetings
// were wrongly flagged.
//
// Summer exception (6/1–8/31 Pacific): check-ins stay weekly but meetings are
// as-needed, so meetings do NOT count toward engagement — only a check-in in
// the window does. Must stay in lockstep with checkinReminder.gs.

const MASTER_SHEET_ID =
  process.env.MASTER_SHEET_ID || '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';
const CHECKINS_TAB = '✅ Check-Ins';

// Matches the reminder's window ("a full calendar week").
const WINDOW_DAYS = 7;

const ZONE = 'America/Los_Angeles';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

// Cell → DateTime or null. Handles Sheets serials, ISO timestamps, the
// Check-Ins tab's plain date strings ("06/12/2026"), and "N/A"/"TBD"/"-".
function parseTimestamp(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!raw) return null;
    const dt = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000)).setZone(ZONE);
    return dt.isValid ? dt : null;
  }
  const s = String(raw).trim();
  if (!s || /^n\/?a$/i.test(s) || /^tbd$/i.test(s) || s === '-') return null;
  let dt = DateTime.fromISO(s, { zone: ZONE });
  if (!dt.isValid) {
    // Parse common Sheets/Forms text formats IN the LA zone. Native new Date(s)
    // would parse a date-only string in the server zone (UTC on Vercel) and land
    // it on the previous Pacific day — the off-by-one this project forbids.
    const FORMATS = ['M/d/yyyy H:mm:ss', 'M/d/yyyy H:mm', 'M/d/yyyy', 'yyyy-MM-dd H:mm:ss', 'M/d/yy'];
    for (const fmt of FORMATS) {
      dt = DateTime.fromFormat(s, fmt, { zone: ZONE });
      if (dt.isValid) break;
    }
  }
  return dt.isValid ? dt : null;
}

const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export async function GET() {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });

    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: MASTER_SHEET_ID,
      ranges: [`'${MASTER_TAB}'!A:BE`, `'${CHECKINS_TAB}'!A:M`],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const [adRows, ciRows] = res.data.valueRanges.map((v) => v.values || []);

    // "✅ Check-Ins" joined by normalized student name.
    // J=9 last Ryan, K=10 upcoming Ryan, L=11 last Aaron, M=12 upcoming Aaron.
    const ciByName = new Map();
    for (const r of ciRows.slice(1)) {
      const key = normName(r?.[0]);
      if (key) ciByName.set(key, r);
    }

    const now = DateTime.now().setZone(ZONE);
    const cutoff = now.minus({ days: WINDOW_DAYS });
    const startOfToday = now.startOf('day');
    // Summer = June 1 – Aug 31 inclusive (Luxon months are 1-based).
    const summerMode = now.month >= 6 && now.month <= 8;

    const recent = (dt) => !!dt && dt >= cutoff;
    const upcoming = (dt) => !!dt && dt >= startOfToday;
    const daysSince = (dt) => (dt ? Math.floor(now.diff(dt, 'days').days) : null);

    // "👩‍🎓 All Data": A=0 name, J=9 email, AY=50 Ryan check-in,
    // BA=52 Aaron check-in, BE=56 Needs Checkin (exclude on explicit FALSE).
    const students = adRows
      .slice(1)
      .map((r) => {
        const email = String(r?.[9] ?? '').trim();
        const name = String(r?.[0] ?? '').trim();
        if (!email || !email.includes('@')) return null;

        const needs = r?.[56];
        const excluded = needs === false || /^false$/i.test(String(needs ?? '').trim());

        const ci = ciByName.get(normName(name)) || [];
        const side = (checkinRaw, lastRaw, upRaw) => {
          const checkin = parseTimestamp(checkinRaw);
          const lastMeeting = parseTimestamp(lastRaw);
          const upcomingMeeting = parseTimestamp(upRaw);
          const reasons = [];
          if (recent(checkin)) reasons.push('checkin');
          if (!summerMode) {
            if (recent(lastMeeting)) reasons.push('recentMeeting');
            if (upcoming(upcomingMeeting)) reasons.push('upcomingMeeting');
          }
          return {
            engaged: reasons.length > 0,
            reasons,
            lastCheckin: checkin ? checkin.toISO() : null,
            daysSinceCheckin: daysSince(checkin),
            lastMeeting: lastMeeting ? lastMeeting.toISO() : null,
            daysSinceMeeting: daysSince(lastMeeting),
            upcomingMeeting: upcoming(upcomingMeeting) ? upcomingMeeting.toISO() : null,
          };
        };

        return {
          name: name || email,
          email,
          excluded,
          ryan: side(r?.[50], ci[9], ci[10]),
          aaron: side(r?.[52], ci[11], ci[12]),
        };
      })
      .filter(Boolean);

    return Response.json({
      windowDays: WINDOW_DAYS,
      summerMode,
      generatedAt: now.toISO(),
      students,
    });
  } catch (err) {
    console.error('checkinCompliance error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
