import { DateTime } from 'luxon'
import { buildTransporter } from '@/lib/studentEmails'

// Flags Google Sheets quota (429) errors so quota pressure is visible instead
// of silently 500ing users. Two outputs:
//   1. A structured SHEETS_QUOTA_429 console line (searchable in Vercel logs).
//   2. A rate-limited email (default: the support inbox, same as parent
//      check-in reports) stamped with the LA day/hour — the inbox itself
//      becomes the longitudinal record, so "is Friday 6pm consistently a
//      problem?" is answered by where the alerts cluster.
// Never throws: alerting must not break the request path it rides on.

const ALERT_TO = process.env.QUOTA_ALERT_TO || 'support@admissions.partners'
const COOLDOWN_MS = 6 * 60 * 60 * 1000 // max one email per 6h per instance

const state = (globalThis.__sheetsQuotaAlert ??= { lastEmailAt: 0 })

export function flagQuotaError(err, source = 'sheets') {
  try {
    const now = DateTime.now().setZone('America/Los_Angeles')
    console.error(
      `SHEETS_QUOTA_429 ts=${now.toISO()} day=${now.toFormat('cccc')} ` +
        `hour=${now.hour} src=${source} msg=${String(err?.message).slice(0, 120)}`
    )
    if (Date.now() - state.lastEmailAt < COOLDOWN_MS) return
    state.lastEmailAt = Date.now()
    if (!process.env.SMTP_HOST) return
    // Fire-and-forget — the failing request is already on its way back.
    buildTransporter()
      .sendMail({
        from: process.env.SMTP_USER,
        to: ALERT_TO,
        subject: `⚠️ Portal hit the Google Sheets read quota (${now.toFormat('ccc h:mm a')})`,
        text:
          `The student portal got a 429 from the Sheets API.\n\n` +
          `When: ${now.toFormat("cccc, LLLL d 'at' h:mm a")} (LA)\n` +
          `Source: ${source}\n\n` +
          `One email is sent at most every 6 hours per server instance — ` +
          `search Vercel logs for SHEETS_QUOTA_429 to see every incident. ` +
          `If these emails cluster around the same day/time each week, that's ` +
          `the signal to bump the per-project read quota (free) in the Google ` +
          `Cloud console, project 640301715818.`,
      })
      .catch((e) => console.error('quota alert email failed:', e?.message))
  } catch (e) {
    console.error('flagQuotaError failed:', e?.message)
  }
}
