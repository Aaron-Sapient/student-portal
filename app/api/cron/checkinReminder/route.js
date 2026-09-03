import { DateTime } from 'luxon';
import { requireCron } from '@/lib/cronAuth';
import { sendAutonomousEmail } from '@/lib/autonomousEmail';
import { getSupabaseClient, MEETING_CAP_SUMMARY } from '@/lib/supabase';
import { emailBaseUrl } from '@/lib/baseUrl';

// The weekly "we haven't heard from you" nudge — Friday noon Pacific.
//
// REPLACES Google Apps Scripts/checkin-reminder/checkinReminder.gs, which read
// Master AY (50) / BA (52) / BE (56) and ✅ Check-Ins J:M directly and is retired
// with this deploy. That script is NOT in this repo (it is clasp-managed under
// support@admissions.partners), so disabling its trigger is Aaron's hands and a
// HARD PREREQUISITE of shipping the zero-google series — see the flip procedure.
//
// ⚠ WHY THE ORDER MATTERS. The GAS fires when a student is NOT engaged. Package D
// stops writing Master AY/BA, so within 7 days `recent()` is false for EVERY
// student and the old script would mail every family, every Friday, wrongly —
// indefinitely. The failure mode is a mass mis-send, not silence. Disable the
// trigger BEFORE the app deploys, not after.
//
// The engagement predicate is preserved exactly:
//   engaged with an instructor = a check-in in the last 7 days
//                             OR a last meeting in the last 7 days
//                             OR an upcoming meeting on file (today or later)
//   summer (Jun 1 – Aug 31): meetings do NOT count; only a check-in suppresses.
//   needs_checkin === false excludes the student entirely.
// Sources move from the two Master tabs to `students` (check-in recency, ex-AY/BA/BE)
// and `meeting_cap_summary` (meeting recency, ex-✅ Check-Ins J:M).
//
// ⚠ Those four meeting columns lost their writer when the reconcile step was
// retired (see scripts/reconcile.cjs). They are stale-but-present: a student with a
// real upcoming meeting still reads as engaged from the last mirrored value, so
// this errs toward NOT nudging. That is the safe direction for an autonomous
// student+parent email, and it is why this ships rather than waiting for lane C.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ZONE = 'America/Los_Angeles';
const WINDOW_DAYS = 7;

// Same kill-switch posture as cron/essayNudge: log the decision, send only when
// armed. Unlike that route this one REPLACES a live sender, so the default is LIVE
// — a silent default here would be a regression, not a safeguard.
const DRY_RUN = process.env.CHECKIN_REMINDER_DRY_RUN === 'true';

function buildEmail(mode, fullName, portalUrl, summer) {
  const first = String(fullName).split(/\s+/)[0] || fullName;
  const checkinLink = `${portalUrl}/check-ins`;
  const sign = `\n\nFill out your check-in here:\n${checkinLink}\n\nThanks,\nAdmissions.Partners`;

  if (mode === 'both') {
    return {
      subject: 'Checking in: let’s reconnect with your Sapient team',
      body:
        `Hi ${first},\n\n` +
        (summer
          ? 'It’s been over a week since your last weekly check-in. A quick reminder that check-ins stay weekly through the summer, even though meetings are as-needed. They’re how Director Ryan and Aaron know what to focus on and whether to get you on the calendar.\n\nPlease take a few minutes to fill out your weekly check-in.'
          : 'It’s been over a week since we’ve seen a check-in or a meeting from you with either Director Ryan or Aaron. We want to make sure you’re staying on track and getting the support you need.\n\nPlease take a few minutes to fill out your weekly check-in. It’s how we know what to focus on and whether to get you on the calendar this week.') +
        sign,
    };
  }
  if (mode === 'ryan') {
    return {
      subject: 'Checking in: let’s reconnect with Director Ryan',
      body:
        `Hi ${first},\n\n` +
        (summer
          ? 'It’s been over a week since your last check-in with Director Ryan. Check-ins stay weekly through the summer even though meetings are as-needed, so please take a few minutes to fill yours out and keep him in the loop.'
          : 'It’s been over a week since you last checked in or met with Director Ryan. Please take a few minutes to fill out your weekly check-in so we can get you back on his calendar before anything slips.') +
        sign,
    };
  }
  return {
    subject: 'Checking in: let’s reconnect with Aaron',
    body:
      `Hi ${first},\n\n` +
      (summer
        ? 'It’s been over a week since your last check-in with Aaron. Check-ins stay weekly through the summer even though meetings are as-needed, so please take a few minutes to fill yours out and keep him in the loop.'
        : 'It’s been over a week since you last checked in or met with Aaron. Please take a few minutes to fill out your weekly check-in so we can get you back on his calendar before anything slips.') +
      sign,
  };
}

// MailApp sent text/plain and the GAS wrapped it to HTML itself, because Gmail
// hard-wraps the plain part at ~76 chars mid-sentence. Same treatment here.
function toHtmlBody(text) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(text)
    .replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>')
    .split('\n')
    .map((line) => (line.trim() ? `<p style="margin:0 0 12px">${line}</p>` : ''))
    .join('');
}

export async function GET(request) {
  const gate = requireCron(request);
  if (!gate.ok) return gate.response;

  try {
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
    const summer = now.month >= 6 && now.month <= 8;

    const parse = (v) => {
      if (!v) return null;
      const dt = DateTime.fromISO(String(v), { zone: ZONE });
      return dt.isValid ? dt : null;
    };
    const recent = (dt) => !!dt && dt >= cutoff;
    const upcoming = (dt) => !!dt && dt >= startOfToday;

    const portalUrl = emailBaseUrl();
    const results = [];

    for (const r of roster || []) {
      const studentEmail = String(r.student_email ?? '').trim();
      // No email = nobody to nudge. This also skips a pre-auth roster row.
      if (!studentEmail || !studentEmail.includes('@')) continue;
      if (r.needs_checkin === false) continue;

      const ci = capById.get(r.student_sheet_id) || {};
      const engaged = (checkin, lastMeeting, upcomingMeeting) => {
        if (recent(parse(checkin))) return true;
        if (summer) return false; // meetings are as-needed 6/1–8/31
        return recent(parse(lastMeeting)) || upcoming(parse(upcomingMeeting));
      };

      const ryanEngaged = engaged(r.last_ryan_checkin, ci.last_ryan_meeting, ci.upcoming_ryan_meeting);
      const aaronEngaged = engaged(r.last_aaron_checkin, ci.last_aaron_meeting, ci.upcoming_aaron_meeting);
      if (ryanEngaged && aaronEngaged) continue;

      const mode = !ryanEngaged && !aaronEngaged ? 'both' : !ryanEngaged ? 'ryan' : 'aaron';

      // Parents are CC'd, as cols K/L were.
      const { data: guards } = await sb
        .from('guardians')
        .select('email, ordinal')
        .eq('student_sheet_id', r.student_sheet_id)
        .order('ordinal');
      const cc = (guards || [])
        .map((g) => String(g.email ?? '').trim())
        .filter((e) => e.includes('@'));

      const msg = buildEmail(mode, r.name, portalUrl, summer);
      results.push({ student: r.name, to: studentEmail, cc, mode });

      if (DRY_RUN) {
        console.log(`[checkinReminder DRY] ${mode} → ${studentEmail} cc=[${cc.join(', ')}] "${msg.subject}"`);
        continue;
      }
      try {
        await sendAutonomousEmail({
          to: studentEmail,
          cc,
          subject: msg.subject,
          text: msg.body,
          html: toHtmlBody(msg.body),
        });
      } catch (mailErr) {
        // One bad address must not abort the run for everyone behind it.
        console.error(`checkinReminder: send failed for ${studentEmail}:`, mailErr?.message || mailErr);
      }
    }

    console.log(`checkinReminder: ${results.length} nudge(s)${DRY_RUN ? ' (DRY RUN)' : ''}, summer=${summer}`);
    return Response.json({ sent: DRY_RUN ? 0 : results.length, dryRun: DRY_RUN, summer, results });
  } catch (err) {
    console.error('checkinReminder error:', err);
    return Response.json({ error: err.message || 'Server error' }, { status: 500 });
  }
}
