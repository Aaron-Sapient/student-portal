import { DateTime } from 'luxon';
import { requireDeveloper } from '@/lib/developerAuth';
import { getSupabaseClient, MEETING_CAP_SUMMARY } from '@/lib/supabase';

// Engagement status per student per instructor, mirroring the logic in
// "Google Apps Scripts/checkinReminder.gs" (the automated Friday reminder):
// engaged = check-in within the window OR a meeting within the window OR an
// upcoming meeting on file. Sources both halves — check-in recency from
// `students`, meeting recency from `meeting_cap_summary`.
//
// Summer exception (6/1–8/31 Pacific): check-ins stay weekly but meetings are
// as-needed, so meetings do NOT count toward engagement — only a check-in in
// the window does. Must stay in lockstep with checkinReminder.gs.

// Matches the reminder's window ("a full calendar week").
const WINDOW_DAYS = 7;

const ZONE = 'America/Los_Angeles';

// Cell → DateTime or null. Handles Sheets serials, ISO timestamps, and "N/A"/"TBD"/"-".
//
// ⚠ This function is read with UNFORMATTED_VALUE (see the batchGet below), so the
// ✅ Check-Ins meeting columns J:M arrive as SERIAL NUMBERS, not as the "06/12/2026"
// strings an earlier version of this comment described — that display form is what the
// OTHER render option returns. Probed live 2026-08-09: J:M = 46219/46252/46241/46244.
// The stale comment is how the off-by-one below survived, so it is corrected rather
// than deleted.
//
// The numeric branch must anchor at MIDNIGHT in ZONE, because this parser is required
// to stay in lockstep with Google Apps Scripts/checkin-reminder/checkinReminder.gs —
// the script that actually emails students — whose `toDate` and `startOfToday` are both
// midnight-LA (appsscript.json pins timeZone America/Los_Angeles). The previous
// `fromMillis(...).setZone(ZONE)` produced 17:00 the PREVIOUS day, which silently broke
// that lockstep: a meeting dated TODAY failed the `upcoming` test, and `daysSince`
// oscillated by a day at 17:00 every afternoon.
function parseTimestamp(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!raw) return null;
    const utc = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000), { zone: 'utc' });
    if (!utc.isValid) return null;
    // Re-anchor the calendar date at midnight ZONE — the DateTime itself is the return
    // value here, so unlike cellToISODate this step is load-bearing, not cosmetic.
    return DateTime.fromObject(
      { year: utc.year, month: utc.month, day: utc.day },
      { zone: ZONE }
    );
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

export async function GET() {
  const gate = await requireDeveloper();
  if (!gate.ok) return gate.response;

  try {
    // Was one Master batchGet over '👩‍🎓 All Data'!A:BE + '✅ Check-Ins'!A:M, joined
    // by NORMALIZED STUDENT NAME. Now two roster reads joined on the FK. The name
    // join was a live defect, not just slower: the two tabs' col-A spellings diverge
    // for real students (lib/checkinIdentity.js), and an unmatched student silently
    // read as "no meetings" — engaged=false on the strength of a spelling.
    const sb = getSupabaseClient();
    const [{ data: roster, error: rErr }, { data: caps, error: cErr }] = await Promise.all([
      sb
        .from('students')
        .select('student_sheet_id, name, student_email, needs_checkin, last_ryan_checkin, last_aaron_checkin')
        .eq('status', 'active'),
      sb
        .from(MEETING_CAP_SUMMARY)
        .select('student_sheet_id, last_ryan_meeting, upcoming_ryan_meeting, last_aaron_meeting, upcoming_aaron_meeting'),
    ]);
    if (rErr) throw new Error(`roster read failed: ${rErr.message}`);
    if (cErr) throw new Error(`cap summary read failed: ${cErr.message}`);

    const capById = new Map((caps || []).map((c) => [c.student_sheet_id, c]));

    const now = DateTime.now().setZone(ZONE);
    const cutoff = now.minus({ days: WINDOW_DAYS });
    const startOfToday = now.startOf('day');
    // Summer = June 1 – Aug 31 inclusive (Luxon months are 1-based).
    const summerMode = now.month >= 6 && now.month <= 8;

    const recent = (dt) => !!dt && dt >= cutoff;
    const upcoming = (dt) => !!dt && dt >= startOfToday;
    const daysSince = (dt) => (dt ? Math.floor(now.diff(dt, 'days').days) : null);

    // Ex-Master cols: name (A), email (J), last_ryan_checkin (AY), last_aaron_checkin
    // (BA), needs_checkin (BE — exclude on explicit FALSE). Students with no email
    // are skipped, as before: that now also skips a pre-auth roster row (phase 2b),
    // which is correct — nobody can be non-compliant before they can sign in.
    const students = (roster || [])
      .map((r) => {
        const email = String(r.student_email ?? '').trim();
        const name = String(r.name ?? '').trim();
        if (!email || !email.includes('@')) return null;

        const excluded = r.needs_checkin === false;

        const ci = capById.get(r.student_sheet_id) || {};
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
          ryan: side(r.last_ryan_checkin, ci.last_ryan_meeting, ci.upcoming_ryan_meeting),
          aaron: side(r.last_aaron_checkin, ci.last_aaron_meeting, ci.upcoming_aaron_meeting),
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
