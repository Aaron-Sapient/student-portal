import { requireCron } from '@/lib/cronAuth'
import { runMeetingTrackers, computeTrackerUpdates } from '@/lib/meetingTrackers'

// Portal-native replacement for the two meeting-tracker Apps Scripts' Supabase mirror.
// Reads Aaron's and Ryan's calendars with the app's own service account and upserts the
// six calendar-derived columns of meeting_cap_summary. See lib/meetingTrackers.js for
// why this moved off Apps Script (Supabase now rejects secret keys from a Mozilla/5.0
// User-Agent, which UrlFetchApp hardcodes).
//
// The Apps Scripts still write their own Sheet2/Sheet3 — Master `✅ Check-Ins` cols
// H/J:N IMPORTRANGE those tabs. Only the Supabase half lives here.
//
// GET ?dry=1 computes and returns the rows WITHOUT writing — safe to hit by hand.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request) {
  const gate = requireCron(request)
  if (!gate.ok) return gate.response

  const dry = new URL(request.url).searchParams.get('dry') === '1'

  try {
    if (dry) {
      const { rows, windows } = await computeTrackerUpdates()
      return Response.json({
        ok: true,
        dryRun: true,
        wouldUpdate: rows.length,
        windows: {
          week: [windows.weekStart.toISO(), windows.weekEnd.toISO()],
          month: [windows.monthStart.toISO(), windows.monthEnd.toISO()],
        },
        sample: rows.slice(0, 5),
      })
    }

    const { updated } = await runMeetingTrackers()
    return Response.json({ ok: true, updated })
  } catch (e) {
    // Loud failstate, same intent as the GAS MailApp alert this replaces: a non-2xx
    // here is what Vercel's cron failure surface reports on.
    console.error('cron/meetingTrackers', e?.message || e)
    return Response.json({ ok: false, error: e?.message || 'meeting tracker run failed' }, { status: 500 })
  }
}
