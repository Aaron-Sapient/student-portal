import { google } from 'googleapis';
import { requireCron } from '@/lib/cronAuth';
import { loadOutreachSnapshot, isSuppressed } from '@/lib/complianceOutreach';
import { sendAutonomousEmail } from '@/lib/autonomousEmail';
import { getSupabaseClient, OUTREACH_LOG } from '@/lib/supabase';
import { emailBaseUrl } from '@/lib/baseUrl';

// Phase 1 — the autonomous student/parent essay nudge, scoped to essay-only seniors.
//
// KILL-SWITCHED: sends real email only when OUTREACH_LIVE === 'true'. Otherwise it
// runs the identical decision path and logs 'essay_nudge_dryrun' rows (channel
// 'DRYRUN') without sending — so it can ride alongside the digest, silent, until the
// data reconciles and the DKIM send-as check passes. Flip OUTREACH_LIVE + add this
// route to vercel.json's crons to go live. See the plan.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LIVE = process.env.OUTREACH_LIVE === 'true';
const MASTER_SHEET_ID = '1YJK05oU_12wX0qK-vTqJJfaS8eVI7JMzdGP0gVso1G4';
const MASTER_TAB = '👩‍🎓 All Data';

function getServiceAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

// Master '👩‍🎓 All Data' A:L → { studentEmail(lower): { name, parents[] } }. Parent CC
// is best-effort: a read failure or an unmatched email degrades to student-only.
async function loadParentIndex() {
  try {
    const sheets = google.sheets({ version: 'v4', auth: getServiceAuth() });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: MASTER_SHEET_ID, range: `${MASTER_TAB}!A:L`, valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const map = new Map();
    for (const r of res.data.values || []) {
      const email = String(r[9] || '').trim().toLowerCase();
      if (!email) continue;
      const parents = [r[10], r[11]].map((e) => String(e || '').trim()).filter((e) => e.includes('@'));
      map.set(email, { name: String(r[0] || '').trim(), parents });
    }
    return map;
  } catch {
    return new Map();
  }
}

function buildEmail(name, baseUrl) {
  const first = String(name || '').split(/\s+/)[0] || 'there';
  const bookUrl = `${baseUrl}/meetings`;
  const subject = 'A quick nudge: book your writing session this week';
  const text =
    `Hi ${first},\n\n` +
    `Thanks for getting your check-in in this week. We don't see a writing session on your calendar yet, ` +
    `and you've got time booked to use with your counselor. It takes about a minute to grab a slot:\n\n` +
    `Book your session: ${bookUrl}\n\n` +
    `This is an automated status note. Questions? Reach us any time at support@admissions.partners.\n\n` +
    `— Admissions Partners`;
  const html =
    `<div style="max-width:560px;margin:0 auto;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#2b2622">
      <p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#9a8f86;margin:0 0 6px">Weekly status</p>
      <p style="margin:0 0 14px">Hi ${first},</p>
      <p style="margin:0 0 14px">Thanks for getting your check-in in this week. We don't see a writing session on your calendar yet, and you've got time booked to use with your counselor — it takes about a minute to grab a slot.</p>
      <p style="margin:0 0 22px"><a href="${bookUrl}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#c6613f;color:#fff;font-weight:600;text-decoration:none">Book your session</a></p>
      <p style="margin:0;font-size:12px;color:#9a8f86">This is an automated status note. Questions? Reach us any time at support@admissions.partners.</p>
    </div>`;
  return { subject, text, html };
}

export async function GET(request) {
  const gate = requireCron(request);
  if (!gate.ok) return gate.response;

  const { rows, thisWeekStart } = await loadOutreachSnapshot();
  const targets = rows.filter((r) => r.phase1WouldFire);
  const sb = getSupabaseClient();
  const kind = LIVE ? 'essay_nudge' : 'essay_nudge_dryrun';
  const baseUrl = emailBaseUrl();
  const parentIndex = LIVE ? await loadParentIndex() : new Map();

  const results = [];
  for (const t of targets) {
    if (await isSuppressed(t.sheetId)) { results.push({ name: t.name, action: 'suppressed' }); continue; }

    // Atomic once-per-week-per-student dedup: INSERT ... ON CONFLICT DO NOTHING via
    // upsert(ignoreDuplicates). Only proceed if THIS call inserted the row.
    const { data: claimed } = await sb.from(OUTREACH_LOG)
      .upsert({
        student_sheet_id: t.sheetId, week_start: thisWeekStart, kind,
        channel: LIVE ? 'AUTONOMOUS' : 'DRYRUN',
        meta: { remaining: t.remaining, primary: t.primary, package: t.package },
      }, { onConflict: 'student_sheet_id,week_start,kind', ignoreDuplicates: true })
      .select('id');
    if (!claimed || claimed.length === 0) { results.push({ name: t.name, action: 'already-logged' }); continue; }

    if (!LIVE) { results.push({ name: t.name, action: 'dryrun-logged' }); continue; }

    const info = parentIndex.get(String(t.email || '').toLowerCase());
    const cc = info?.parents || [];
    const { subject, text, html } = buildEmail(t.name, baseUrl);
    try {
      await sendAutonomousEmail({ to: t.email, cc, subject, text, html });
      await sb.from(OUTREACH_LOG)
        .update({ recipient_emails: [t.email, ...cc], subject })
        .eq('student_sheet_id', t.sheetId).eq('week_start', thisWeekStart).eq('kind', kind);
      results.push({ name: t.name, action: 'sent', cc: cc.length });
    } catch (e) {
      results.push({ name: t.name, action: 'send-failed', error: String(e?.message || e) });
    }
  }

  return Response.json({ ok: true, live: LIVE, week: thisWeekStart, wouldFire: targets.length, results });
}
