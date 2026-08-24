import { DateTime } from 'luxon'
import { getGoogleCalendarClient, getGoogleDriveClient } from './google'
import { getSupabaseClient, MEETING_CAP_SUMMARY } from './supabase'

// Portal-native port of the two meeting-tracker Apps Scripts (2026-08-23).
//
// WHY THIS MOVED. The GAS mirrors wrote meeting_cap_summary directly with a Supabase
// key held in Script Properties. When the project's legacy JWT was revoked (RLS
// downgrade, 2026-08-22) that key became an `sb_secret_*` key, and Supabase refuses
// secret keys from anything whose User-Agent starts with `Mozilla/5.0` — which is
// exactly what UrlFetchApp hardcodes. Reproduced 2026-08-23: `Mozilla/5.0` → 401
// "Forbidden use of secret API key in browser"; `Google-Apps-Script`, `curl`, a bare
// name → 200. There is no header fix inside Apps Script, so the credential moved to
// the side that already has a secure runtime: this app.
//
// The service account (GOOGLE_SERVICE_ACCOUNT_EMAIL) already carries auth/calendar and
// was verified 2026-08-23 to read every calendar below. It sees 45-48 of Ryan's events
// as bare "Busy" with no title (his private all-day block-offs, 300-2100 min); ZERO
// masked events fall in the 15-60 min student-session range, so title matching is
// unaffected. Aaron's calendar has no masking at all.
//
// The Apps Scripts KEEP writing their own Sheet2/Sheet3 — Master `✅ Check-Ins` cols
// H/J:N are live IMPORTRANGE formulas pointed at those tabs, so deleting the GAS would
// take that tab down. Only the Supabase half belongs here.
//
// ⚠ SECOND WRITER: scripts/backfillCheckinSummary.cjs (NAS reconcile cron, hourly) also
// upserts these same columns, sourced from Master ✅ Check-Ins. Both ultimately derive
// from the same calendars, so they agree modulo trigger cadence, but this route is NOT
// the sole authority until that script stops writing the six calendar-derived columns.

const ZONE = 'America/Los_Angeles'

// Transcribed from the live scripts (clasp pull 2026-08-23, zero drift vs local).
//
// ⚠ Ryan's tracker reads ryan@ryanchoice.com — NOT the ryansapientchoice@gmail.com that
// GOOGLE_CALENDAR_ID_RYAN points the BOOKING flow at. The two calendars are both
// readable and differ (207 vs 202 events in the same window, measured 2026-08-23).
// Parity with the GAS requires ryanchoice.com; do not "unify" these without deciding
// which one is authoritative for booking.
export const TRACKERS = {
  aaron: {
    key: 'aaron',
    calendarId: process.env.MEETING_TRACKER_CALENDAR_AARON || 'aaronblumenthal21@gmail.com',
    // Aaron's cap is WEEKLY (Mon-Fri of the current week).
    countMode: 'week',
    columns: {
      last: 'last_aaron_meeting',
      upcoming: 'upcoming_aaron_meeting',
      used: 'meetings_used_weekly_aaron',
    },
  },
  ryan: {
    key: 'ryan',
    calendarId: process.env.MEETING_TRACKER_CALENDAR_RYAN || 'ryan@ryanchoice.com',
    // Ryan's cap is MONTHLY (the calendar month).
    countMode: 'month',
    columns: {
      last: 'last_ryan_meeting',
      upcoming: 'upcoming_ryan_meeting',
      used: 'meetings_used',
    },
  },
}

const LOOKBACK_DAYS = 30 // getLastMeetingDate window
const LOOKAHEAD_DAYS = 14 // getUpcomingMeeting window

// Replaces each tracker spreadsheet's optional "Aliases" tab (col A = roster name,
// col B = alias) — for a student whose calendar events use a different name than the
// roster, e.g. Victoria Baek going by "Seoah". Both live tabs were empty as of the
// 2026-08-23 port, so this starts empty; keys are normalizeName() of the roster name.
export const NAME_ALIASES = {
  // 'victoriabaek': ['Seoah'],
}

// The permanent known-good fixture — same id lib/complianceOutreach.js excludes from the
// digest. Its meeting_cap_summary numbers are hand-maintained, and it has no calendar
// events, so a calendar-derived run would silently zero the fixture. The Apps Scripts
// never touched it (it isn't in their Sheet2 col A); this route drives off the Supabase
// roster instead, which is a superset, so the exclusion has to be explicit here.
const TEST_SHEET_IDS = new Set(['1UW-RSqv30c_BUdv9nfm48YVVs7L-UmWKsYn_jXhYt6w'])

export function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '')
}

// Verbatim port of isStudentMatch() / matchesStudent() from both scripts:
//   - skip anything whose title OR description mentions a parent
//   - match when EVERY part of the name appears, or when the first name alone appears
//   - aliases are tried as additional whole names
export function matchesStudent(event, studentName, aliases = []) {
  const title = String(event.title || '').toLowerCase()
  const description = String(event.description || '').toLowerCase()

  if (title.includes('parent') || description.includes('parent')) return false

  return [studentName, ...aliases].some((name) => {
    const parts = String(name || '').toLowerCase().split(' ').filter((p) => p.length > 0)
    if (parts.length === 0) return false
    const firstName = parts[0]
    const fullMatch = parts.every((p) => title.includes(p) || description.includes(p))
    const firstNameOnly = title.includes(firstName) || description.includes(firstName)
    return fullMatch || firstNameOnly
  })
}

// The GAS ran in the script's timezone and used a bare `new Date()`. On Vercel the
// server is UTC, so every window is built explicitly in LA (project CLAUDE.md).
export function trackerWindows(now = DateTime.now().setZone(ZONE)) {
  return {
    lookbackStart: now.minus({ days: LOOKBACK_DAYS }),
    lookaheadEnd: now.plus({ days: LOOKAHEAD_DAYS }),
    weekStart: now.startOf('week'), // Luxon weeks are ISO -> Monday 00:00
    weekEnd: now.startOf('week').plus({ days: 4 }).endOf('day'), // Friday 23:59:59.999
    monthStart: now.startOf('month'),
    monthEnd: now.endOf('month'),
  }
}

// An all-day event carries `start.date` (no zone); a timed one carries `start.dateTime`.
// CalendarApp.getStartTime() returns local midnight for the former, so anchor in LA.
function eventStart(raw) {
  if (raw?.start?.dateTime) return DateTime.fromISO(raw.start.dateTime).setZone(ZONE)
  if (raw?.start?.date) return DateTime.fromISO(raw.start.date, { zone: ZONE }).startOf('day')
  return null
}

async function fetchEvents(calendarId, timeMin, timeMax) {
  const calendar = getGoogleCalendarClient()
  const events = []
  let pageToken
  do {
    const res = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toUTC().toISO(),
      timeMax: timeMax.toUTC().toISO(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
      pageToken,
    })
    for (const raw of res.data.items || []) {
      const start = eventStart(raw)
      if (!start || !start.isValid) continue
      events.push({ start, title: raw.summary || '', description: raw.description || '' })
    }
    pageToken = res.data.nextPageToken
  } while (pageToken)
  return events
}

// One row per roster student per instructor. The GAS resolved names against
// meeting_cap_summary anyway (getSupabaseStudentMap_), so driving straight off that
// table is the same student set, minus the sheet hop.
export async function computeTrackerUpdates(now = DateTime.now().setZone(ZONE)) {
  const w = trackerWindows(now)
  const sb = getSupabaseClient()

  const { data: roster, error } = await sb
    .from(MEETING_CAP_SUMMARY)
    .select('student_sheet_id, student_name')
  if (error) throw new Error(`roster read failed: ${error.message}`)

  // One fetch per calendar covering every window any tracker needs.
  const fetchStart = DateTime.min(w.lookbackStart, w.monthStart)
  const fetchEnd = DateTime.max(w.lookaheadEnd, w.monthEnd)

  const byInstructor = {}
  for (const t of Object.values(TRACKERS)) {
    byInstructor[t.key] = await fetchEvents(t.calendarId, fetchStart, fetchEnd)
  }

  const updates = new Map()
  const unresolved = []

  for (const student of roster || []) {
    const name = String(student.student_name || '').trim()
    if (!name) continue
    if (TEST_SHEET_IDS.has(student.student_sheet_id)) continue
    const aliases = NAME_ALIASES[normalizeName(name)] || []
    const row = { student_sheet_id: student.student_sheet_id, student_name: name }

    for (const t of Object.values(TRACKERS)) {
      const mine = byInstructor[t.key].filter((ev) => matchesStudent(ev, name, aliases))

      // Last: most recent match strictly in the past, within 30 days back.
      let last = null
      // Upcoming: soonest match strictly in the future, within 14 days ahead.
      let next = null
      let used = 0

      for (const ev of mine) {
        const isPast = ev.start < now
        if (isPast && ev.start >= w.lookbackStart) {
          if (!last || ev.start > last) last = ev.start
        }
        if (!isPast && ev.start <= w.lookaheadEnd) {
          if (!next || ev.start < next) next = ev.start
        }
        const inCount = t.countMode === 'week'
          ? ev.start >= w.weekStart && ev.start <= w.weekEnd
          : ev.start >= w.monthStart && ev.start <= w.monthEnd
        if (inCount) used += 1
      }

      row[t.columns.last] = last ? last.toUTC().toISO() : null
      row[t.columns.upcoming] = next ? next.toUTC().toISO() : null
      row[t.columns.used] = used
    }

    updates.set(student.student_sheet_id, row)
  }

  return { rows: [...updates.values()], unresolved, windows: w }
}

// --- staleness watchdog for the half that stayed in Apps Script -------------------
//
// Removing the Supabase mirror from the trackers also removed their loud failstate, and
// that failstate was the only thing watching the SHEET write. If an Apps Script trigger
// dies, Sheet2/Sheet3 quietly stop updating, Master `✅ Check-Ins` freezes through its
// IMPORTRANGE formulas, and nothing tells anyone -- the exact "a cell nobody watches"
// failure the mirror was built to kill, one layer up. So this route, which already holds
// a Google client, watches the sheets' modifiedTime instead.
//
// Both ids read live out of Master `✅ Check-Ins` row-2 IMPORTRANGE formulas (2026-08-23).
export const TRACKER_SHEETS = {
  aaron: {
    id: '1WS8w1PgDSq9Jy745_up8tMov5wXGQAiYBmFwnwQ6L7k',
    label: "Aaron's meeting tracker",
    feeds: 'Master ✅ Check-Ins cols L/M/N',
  },
  ryan: {
    id: '1zWBphAfzQ3tI_ffthZ1ZAPGueeVRNbG-Vaoxrkw1xtE',
    label: "Ryan's meeting tracker",
    feeds: 'Master ✅ Check-Ins cols H/J/K',
  },
}

// Both triggers currently run nightly (~00:15 and ~00:52 PT, observed 2026-08-23), so
// 36h tolerates one missed run plus slack before crying wolf.
const SHEET_STALE_HOURS = 36

export async function checkTrackerSheetFreshness(now = DateTime.now().setZone(ZONE)) {
  const drive = getGoogleDriveClient()
  const results = []
  for (const t of Object.values(TRACKER_SHEETS)) {
    try {
      const res = await drive.files.get({ fileId: t.id, fields: 'name, modifiedTime' })
      const modified = DateTime.fromISO(res.data.modifiedTime).setZone(ZONE)
      const ageHours = now.diff(modified, 'hours').hours
      results.push({
        ...t,
        name: res.data.name,
        modified: modified.toISO(),
        ageHours: Math.round(ageHours * 10) / 10,
        stale: ageHours > SHEET_STALE_HOURS,
        error: null,
      })
    } catch (e) {
      // Unreadable is its own kind of broken (revoked share, deleted file) — report it
      // rather than letting a throw take the whole cron down.
      results.push({ ...t, name: null, modified: null, ageHours: null, stale: true, error: e?.message || 'unreadable' })
    }
  }
  return results
}

export async function runMeetingTrackers(now = DateTime.now().setZone(ZONE)) {
  const { rows, windows } = await computeTrackerUpdates(now)
  if (!rows.length) return { updated: 0, rows: [], windows }

  const sb = getSupabaseClient()
  // merge-duplicates on the PK, same as the GAS mirror — only the columns present in
  // each payload are touched, so the hand-typed `meetings_allowed*` caps survive.
  const { error } = await sb
    .from(MEETING_CAP_SUMMARY)
    .upsert(rows, { onConflict: 'student_sheet_id' })
  if (error) throw new Error(`meeting_cap_summary upsert failed: ${error.message}`)

  return { updated: rows.length, rows, windows }
}
