import { DateTime } from 'luxon'
import { requireCron } from '@/lib/cronAuth'
import { buildTransporter } from '@/lib/studentEmails'
import {
  runMeetingTrackers,
  computeTrackerUpdates,
  checkTrackerSheetFreshness,
} from '@/lib/meetingTrackers'

// Portal-native replacement for the two meeting-tracker Apps Scripts' Supabase mirror.
// Reads Aaron's and Ryan's calendars with the app's own service account and upserts the
// six calendar-derived columns of meeting_cap_summary. See lib/meetingTrackers.js for
// why this moved off Apps Script (Supabase now rejects secret keys from a Mozilla/5.0
// User-Agent, which UrlFetchApp hardcodes).
//
// The Apps Scripts still write their own Sheet2/Sheet3 — Master `✅ Check-Ins` cols
// H/J:N IMPORTRANGE those tabs. Only the Supabase half lives here, so this route also
// watches those sheets for staleness: pulling the mirror out of the trackers removed
// their loud failstate, and this replaces it.
//
// GET ?dry=1 computes and returns everything WITHOUT writing or emailing.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ALERT_TO = process.env.QUOTA_ALERT_TO || 'support@admissions.partners'

async function alertStaleSheets(stale, now) {
  if (!stale.length || !process.env.SMTP_HOST) return false
  const lines = stale.map((s) =>
    s.error
      ? `• ${s.label} — UNREADABLE (${s.error}). Feeds ${s.feeds}.`
      : `• ${s.label} — last written ${s.ageHours}h ago (${DateTime.fromISO(s.modified).toFormat("ccc LLL d, h:mm a")} LA). Feeds ${s.feeds}.`
  )
  await buildTransporter()
    .sendMail({
      from: process.env.SMTP_USER,
      to: ALERT_TO,
      subject: `⚠️ Meeting-tracker sheet is stale (${now.toFormat('ccc h:mm a')})`,
      text:
        `A meeting-tracker spreadsheet has stopped updating, which means its Apps Script\n` +
        `trigger is probably dead.\n\n` +
        `${lines.join('\n')}\n\n` +
        `Why this matters: those tabs feed Master ✅ Check-Ins through live IMPORTRANGE\n` +
        `formulas, so the Check-Ins tab is now showing frozen meeting data.\n\n` +
        `Fix: open the Apps Script project (script.google.com), check Triggers, and\n` +
        `re-add or re-authorize the time-driven trigger. The Supabase half of these\n` +
        `numbers is unaffected — this route writes meeting_cap_summary directly from\n` +
        `the calendars and is still current.`,
    })
    .catch((e) => console.error('stale-sheet alert email failed:', e?.message))
  return true
}

export async function GET(request) {
  const gate = requireCron(request)
  if (!gate.ok) return gate.response

  const dry = new URL(request.url).searchParams.get('dry') === '1'
  const now = DateTime.now().setZone('America/Los_Angeles')

  try {
    const sheets = await checkTrackerSheetFreshness(now)
    const stale = sheets.filter((s) => s.stale)

    if (dry) {
      const { rows, windows } = await computeTrackerUpdates(now)
      return Response.json({
        ok: true,
        dryRun: true,
        wouldUpdate: rows.length,
        windows: {
          week: [windows.weekStart.toISO(), windows.weekEnd.toISO()],
          month: [windows.monthStart.toISO(), windows.monthEnd.toISO()],
        },
        sheets,
        wouldAlert: stale.length > 0,
        sample: rows.slice(0, 5),
      })
    }

    const { updated } = await runMeetingTrackers(now)
    // Sheet staleness is reported but never fatal — the Supabase half already succeeded.
    const alerted = await alertStaleSheets(stale, now)
    if (stale.length) {
      console.warn('TRACKER_SHEET_STALE', JSON.stringify(stale.map((s) => ({ id: s.id, ageHours: s.ageHours, error: s.error }))))
    }

    return Response.json({ ok: true, updated, sheets, staleCount: stale.length, alerted })
  } catch (e) {
    // Loud failstate, same intent as the GAS MailApp alert this replaces: a non-2xx
    // here is what Vercel's cron failure surface reports on.
    console.error('cron/meetingTrackers', e?.message || e)
    return Response.json({ ok: false, error: e?.message || 'meeting tracker run failed' }, { status: 500 })
  }
}
