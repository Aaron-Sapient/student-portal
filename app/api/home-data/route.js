import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient, getGoogleCalendarClient } from '@/lib/google'
import { getStudentScores, gradeFromClass } from '@/lib/scores'
import { hasRecentGrades, TRANSCRIPT_GRADE_RANGE } from '@/lib/gradeData'
import { normEmail, sessionEmail } from '@/lib/identity'
import { activeProjectsFromRows } from '@/lib/projects'
import {
  getSeniorBySheetId,
  weekSummary,
  fetchSeniorMeetings,
  bookedForWeekOf,
  startOfSaturdayWeek,
  checkedInThisWeek,
  PACKAGE_RULES,
} from '@/lib/seniors'
import { DateTime } from 'luxon'

const ZONE = 'America/Los_Angeles'

// Sheets serial number or string → LA calendar date (mirrors portalUtils).
function toLADate(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number') {
    const utc = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000), { zone: 'utc' })
    if (!utc.isValid) return null
    return DateTime.fromObject({ year: utc.year, month: utc.month, day: utc.day }, { zone: ZONE })
  }
  const dt = DateTime.fromISO(String(raw), { zone: ZONE })
  return dt.isValid ? dt : null
}

// 📆 Meetings grids aren't perfectly uniform: most sheets have Date in col B,
// but some start the table at col A. Find the 'Date' header in the first few
// rows and read that column (plus the Teacher column beside it); fall back to
// the col-B convention. Returns [{ date, teacher }] with raw cell values.
function meetingLogRows(rows) {
  let dateCol = 1
  let teacherCol = 2
  let firstDataRow = 1
  for (let r = 0; r < Math.min(rows.length, 4); r++) {
    const cells = (rows[r] || []).map((v) => String(v ?? '').trim().toLowerCase())
    const c = cells.indexOf('date')
    if (c >= 0) {
      dateCol = c
      const t = cells.indexOf('teacher')
      teacherCol = t >= 0 ? t : c + 1
      firstDataRow = r + 1
      break
    }
  }
  return rows.slice(firstDataRow).map((row) => ({
    date: (row || [])[dateCol],
    teacher: String((row || [])[teacherCol] ?? '').trim().toLowerCase(),
  }))
}

// Sessions = the union of the sheet log (📆 Meetings — Aaron's hand log) and
// meetings actually booked on the instructors' calendars. The same meeting can
// appear in both (Aaron logs a booked meeting), so per LA day and per
// instructor we take max(sheet count, calendar count): dedups the overlap while
// still counting two genuinely separate same-day meetings as two.
function dailySessionCounts(logRows, calEvents, now) {
  const days = new Map() // ISO day → { sheetA, sheetR, calA, calR }
  const bump = (dayISO, key) => {
    const d = days.get(dayISO) || { sheetA: 0, sheetR: 0, calA: 0, calR: 0 }
    d[key]++
    days.set(dayISO, d)
  }
  for (const { date, teacher } of logRows) {
    const dt = toLADate(date)
    if (!dt || dt > now) continue
    bump(dt.toISODate(), teacher === 'ryan' ? 'sheetR' : 'sheetA')
  }
  for (const ev of calEvents) {
    bump(ev.day, ev.instructor === 'ryan' ? 'calR' : 'calA')
  }
  const counts = new Map()
  for (const [day, d] of days) {
    counts.set(day, Math.max(d.sheetA, d.calA) + Math.max(d.sheetR, d.calR))
  }
  return counts
}

// Per-day counts → last-12-week buckets (Mon-start LA weeks, oldest first).
// Future-dated rows (seeded demo data, pre-logged sessions) never reach here.
function weeklySessionCounts(dayCounts) {
  const now = DateTime.now().setZone(ZONE)
  const start = now.startOf('week').minus({ weeks: 11 })
  const buckets = Array.from({ length: 12 }, (_, i) => ({
    week: start.plus({ weeks: i }).toISODate(),
    count: 0,
  }))
  for (const [day, count] of dayCounts) {
    const dt = DateTime.fromISO(day, { zone: ZONE })
    const idx = Math.floor(dt.startOf('week').diff(start, 'weeks').weeks)
    if (idx >= 0 && idx < 12) buckets[idx].count += count
  }
  return buckets
}

// Past booked meetings for the sessions strip: events on an instructor's
// calendar in the 12-week window whose title carries the student's name (the
// same matching convention as getUpcomingMeetings). Returns [{ day, instructor }].
async function fetchPastBookedMeetings(calendar, calendarId, instructor, studentName) {
  if (!calendarId || !studentName) return []
  const now = DateTime.now().setZone(ZONE)
  const windowStart = now.startOf('week').minus({ weeks: 11 })
  try {
    const res = await calendar.events.list({
      calendarId,
      timeMin: windowStart.toISO(),
      timeMax: now.toISO(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    })
    const name = studentName.toLowerCase().trim()
    return (res.data.items || [])
      .filter((e) => e.status !== 'cancelled' && e.summary?.toLowerCase().includes(name))
      .map((e) => ({
        day: DateTime.fromISO(e.start?.dateTime || e.start?.date || '')
          .setZone(ZONE)
          .toISODate(),
        instructor, // ART rides Aaron's calendar → counts as aaron
      }))
      .filter((e) => e.day)
  } catch {
    return [] // calendar unavailable → sessions degrade to the sheet log alone
  }
}

export async function GET() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const userEmail = sessionEmail(sessionClaims)
  const sheets = getGoogleSheetsClient(userEmail)
  const calendar = getGoogleCalendarClient(userEmail)

  // A:BD so col A (name — what calendar event titles carry) rides along.
  // Indices match scripts/nas/scoreStudents.cjs listStudents: name 0, portal
  // URL 6, email 9, check-in/token block 50–55.
  const masterRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: "'👩‍🎓 All Data'!A:BD",
  })

  const masterRows = masterRes.data.values || []

  const studentRow = masterRows.find(row => normEmail(row[9]) === normEmail(userEmail))

  if (!studentRow) return Response.json({ error: 'Student not found' }, { status: 404 })

  const masterName = (studentRow[0] || '').trim()
  const portalUrl = studentRow[6]

  const sheetIdMatch = portalUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/)
  console.log('6. Extracted sheet ID:', sheetIdMatch?.[1])

  if (!sheetIdMatch) return Response.json({ error: 'Invalid portal URL' }, { status: 400 })

  const studentSheetId = sheetIdMatch[1]

  // Fetch projects, student name + grade (🔎 Overview, gates the Colleges tab),
  // the weekly holistic scores (📊 Scores, written by the NAS cron), and the
  // session log (📆 Meetings dates → frequency strip) in parallel
  const [projectsRes, nameRes, rawScores, transcriptRes, meetingDatesRes, aaronPast, ryanPast] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      // E:N — Owner lives in col N (relative index 9). Appended right of the
      // E:M block so existing indices (0–8) are unchanged. See plan + sheet audit.
      range: "'🏆 Comps & Projects'!E:N",
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      // B2 = student name; C4 = "Current Year:" grade (gates the Colleges tab).
      // One read serves both — see studentName / currentYear below.
      range: "'🔎 Overview'!B2:C4",
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    getStudentScores(sheets, studentSheetId, gradeFromClass(studentRow[1])),
    sheets.spreadsheets.values
      .get({
        spreadsheetId: studentSheetId,
        range: TRANSCRIPT_GRADE_RANGE,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      .catch(() => null),
    sheets.spreadsheets.values
      .get({
        spreadsheetId: studentSheetId,
        range: "'📆 Meetings'!A1:C400",
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
      .catch(() => null),
    fetchPastBookedMeetings(calendar, process.env.GOOGLE_CALENDAR_ID_AARON, 'aaron', masterName),
    fetchPastBookedMeetings(calendar, process.env.GOOGLE_CALENDAR_ID_RYAN, 'ryan', masterName),
  ])

  // Data-sufficiency gate: a student with no recorded grades for the current or
  // previous semester gets a grayed-out score dashboard (and the cron skips
  // scoring them). Computed from the transcript so it overrides any stale row.
  const nowLA = DateTime.now().setZone(ZONE)
  const gradeGate = hasRecentGrades(
    transcriptRes?.data?.values || [],
    studentRow[1],
    { year: nowLA.year, month: nowLA.month }
  )
  const scores = gradeGate.enough ? rawScores : { insufficientData: true }

  const sessions = weeklySessionCounts(
    dailySessionCounts(
      meetingLogRows(meetingDatesRes?.data?.values || []),
      [...aaronPast, ...ryanPast],
      DateTime.now().setZone(ZONE)
    )
  )

  // Colleges tab = 12th-graders only. Gate on the student's grade
  // (🔎 Overview!C4 "Current Year:" === "12th"), NOT on a 🏫 College List tab:
  // every student gets that tab from day 1 so Ryan can build the list early, so
  // tab-presence both leaks Colleges to underclassmen and hides it from a senior
  // whose tab isn't created yet.
  const currentYear = String(nameRes.data.values?.[2]?.[1] || '').trim()
  const hasCollegeList = currentYear === '12th'

  // "Project progress" line: always aggregated across 🏆 Comps & Projects —
  // seniors keep working on projects too (college-app progress lives in the
  // Colleges tab, not here). Computed below once activeProjects is built.
  let progress = null

  const studentName = nameRes.data.values?.[0]?.[0] || ''
  console.log('Student name:', studentName)

  const projectRows = projectsRes.data.values || []
  console.log('7. Project rows found:', projectRows.length)
  console.log('8. All project rows:', JSON.stringify(projectRows))

const meetingType = studentRow[51] || null;
const aaronLastCheckin = studentRow[52] || null;
const aaronMeetingType = studentRow[53] || null;

// ART eligibility (col BC) + token (col BD = ISO timestamp of last booking, or empty).
// Token is "available" iff isART AND (BD empty OR BD timestamp is older than this week's Saturday).
const isART = studentRow[54] === 'TRUE' || studentRow[54] === true;
const artBookingTimestamp = studentRow[55] || '';

let artTokenAvailable = false;
if (isART) {
  if (!artBookingTimestamp) {
    artTokenAvailable = true;
  } else {
    const bookingDate = DateTime.fromISO(String(artBookingTimestamp)).setZone('America/Los_Angeles');
    if (bookingDate.isValid) {
      const now = DateTime.now().setZone('America/Los_Angeles');
      let mostRecentSaturday = now.set({ weekday: 6 });
      if (now.weekday < 6) mostRecentSaturday = mostRecentSaturday.minus({ weeks: 1 });
      mostRecentSaturday = mostRecentSaturday.startOf('day');
      artTokenAvailable = bookingDate < mostRecentSaturday;
    } else {
      // Couldn't parse — treat as available rather than locking the student out.
      artTokenAvailable = true;
    }
  }
}

  const activeProjects = activeProjectsFromRows(projectRows)

  console.log('10. Active projects:', JSON.stringify(activeProjects))

  {
    const vals = activeProjects
      .map((p) => p.progress)
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
    if (vals.length) {
      progress = {
        value: vals.reduce((a, b) => a + b, 0) / vals.length,
        count: vals.length,
      }
    }
  }

  // Senior essay-program context. When present, the portal swaps the underclassman
  // check-in/15-30 booking UI for the deterministic senior flow. Everything the
  // client needs to render that (without importing the server-only seniors lib).
  const senior = await getSeniorBySheetId(studentSheetId)
  let seniorContext = null
  if (senior) {
    const ws = startOfSaturdayWeek(nowLA)
    const meetings = await fetchSeniorMeetings(
      calendar,
      senior,
      ws.toISO(),
      ws.plus({ weeks: 1 }).toISO()
    )
    const booked = bookedForWeekOf(meetings, nowLA)
    const summary = weekSummary(senior, nowLA, booked)
    const rule = PACKAGE_RULES[senior.package]
    const totalCount = summary.booked[summary.primarySlug].count + summary.booked[summary.secondarySlug].count
    const totalMin = summary.booked[summary.primarySlug].minutes + summary.booked[summary.secondarySlug].minutes
    const remaining =
      senior.package === 'essential'
        ? Math.max(0, Math.floor((rule.budgetMin - totalMin) / 20))
        : Math.max(0, rule.maxPerWeek - totalCount)
    seniorContext = {
      package: senior.package,
      packageLabel: rule.label,
      packageNote: rule.note,
      phase: senior.phase,
      isPhaseWeek: summary.isPhaseWeek,
      secondaryRequired: summary.secondaryRequired,
      primarySlug: summary.primarySlug,
      secondarySlug: summary.secondarySlug,
      primaryName: summary.primaryName,
      secondaryName: summary.secondaryName,
      bookable: summary.bookable, // { aaron:[durations], ryan:[durations] }
      booked: summary.booked,
      denominations: rule.denominations,
      maxPerWeek: rule.maxPerWeek,
      checkedIn: checkedInThisWeek(studentRow[50], nowLA),
      remaining,
    }
  }

  return Response.json({
    activeProjects,
    studentName,
    lastCheckin: studentRow[50] || null,
    meetingType,
    aaronLastCheckin,
    aaronMeetingType,
    isART,
    artTokenAvailable,
    hasCollegeList,
    scores,
    progress,
    sessions,
    senior: seniorContext,
  })
}