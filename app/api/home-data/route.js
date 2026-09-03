import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'
import { getStudentScores, gradeFromClass } from '@/lib/scores'
import { hasRecentGrades } from '@/lib/gradeData'
import { studentGradeGate } from '@/lib/transcript'
import { sessionEmail, getStudentByEmail, getStudentProfile, studentDisplay } from '@/lib/identity'
import { activeProjectsFromRows, getProjectRows } from '@/lib/projects'
import {
  getSeniorBySheetId,
  loadSeniorBookingState,
  seniorBookingPlan,
  checkedInThisWeek,
} from '@/lib/seniors'
import { projectMeetingCards } from '@/lib/projectMeetings'
import { getBookingTokens } from '@/lib/bookingTokens'
import { pastBookingDays } from '@/lib/bookings'
import { getSessionLog } from '@/lib/meetings'
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

// Past booked meetings for the sessions strip: the three Postgres booking ledgers
// (bookings + project_meeting_bookings + senior_bookings, lib/bookings.js) over the
// 12-week window. Replaced the Calendar list + title fuzzy-match on 2026-08-27
// (zero-Google sweep, Package C): the record is Postgres; a Calendar outage no
// longer blanks the strip. Returns [{ day, instructor }]; [] on a DB error so the
// sessions strip degrades to the sheet log alone, as before.
async function fetchPastBookedDays(studentSheetId) {
  const now = DateTime.now().setZone(ZONE)
  const windowStart = now.startOf('week').minus({ weeks: 11 })
  try {
    return await pastBookingDays(studentSheetId, windowStart.toISODate(), now.toISODate())
  } catch (e) {
    console.error('home-data: past bookings read failed (sessions strip degrades to the log):', e?.message || e)
    return []
  }
}

export async function GET() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const userEmail = sessionEmail(sessionClaims)

  // Identity + the whole check-in block (AY/BA/BC/BE) come from Supabase
  // `students` — the record of truth (ruling 2026-08-27). No Master read: this
  // payload is served from Postgres even if the Google Workspace vanished.
  // `sheets` survives ONLY as the pass-through argument of the flag-gated
  // per-domain readers below (comps / scores / transcript / meetings — the §4
  // deletion sweep collapses those).
  let student
  try {
    student = await getStudentByEmail(userEmail)
  } catch (e) {
    console.error('home-data: student lookup failed:', e?.message || e)
    return Response.json({ error: 'Student lookup failed' }, { status: 503 })
  }
  if (!student) return Response.json({ error: 'Student not found' }, { status: 404 })

  const masterName = String(student.name ?? '').trim()
  const studentSheetId = student.student_sheet_id
  console.log('6. Student sheet ID:', studentSheetId)
  if (!studentSheetId) return Response.json({ error: 'No student sheet on record' }, { status: 400 })

  const sheets = getGoogleSheetsClient(userEmail)

  // Fetch projects, the 🔎 Overview mirror (name + grade — gates the Colleges
  // tab), the weekly holistic scores (📊 Scores, written by the NAS cron), and
  // the session log (📆 Meetings dates → frequency strip) in parallel
  const nowLA = DateTime.now().setZone(ZONE)
  const [projectRows, profile, rawScores, gradeGate, sessionLog, pastBooked] = await Promise.all([
    // 🏆 Comps & Projects E:N rows per the `comps` flag (Sheets today). Owner in
    // col N (relative index 9), appended right of E:M so indices 0–8 are unchanged.
    getProjectRows(sheets, studentSheetId),
    // student_profiles.display_name / current_year — the B2 / C4 mirror. Never
    // throws; null on a missing row, and studentDisplay() degrades to the roster
    // name + students.grade. A sheet with no 🔎 Overview tab (obsolete template,
    // essays-only students — Ryan Koo, 2026-08-26) used to reject the whole
    // Promise.all and blank every booking card on the Meetings tab.
    getStudentProfile(studentSheetId),
    getStudentScores(sheets, studentSheetId, gradeFromClass(student.class)),
    // Data-sufficiency gate per the `transcript` flag (Sheets today). On a read
    // error, fall through to hasRecentGrades([]) — the exact prior behavior of the
    // old `.catch(() => null)` + `transcriptRes?.data?.values || []`.
    studentGradeGate(sheets, studentSheetId, student.class, { year: nowLA.year, month: nowLA.month })
      .catch(() => hasRecentGrades([], student.class, { year: nowLA.year, month: nowLA.month })),
    // 📆 Meetings session log per the `meetings` flag (Sheets today). Returns
    // [{ date, teacher }] — the meetingLogRows shape dailySessionCounts expects.
    getSessionLog(sheets, studentSheetId).catch(() => []),
    // Booked meetings (all three ledgers) → [{ day, instructor }] for the strip.
    fetchPastBookedDays(studentSheetId),
  ])

  // gradeGate (data-sufficiency) and projectRows now come straight from the
  // flag-gated readers in the Promise.all above. A student with no recent grades
  // gets a grayed-out dashboard; the NAS cron applies the same gate.
  const scores = gradeGate.enough ? rawScores : { insufficientData: true }

  const sessions = weeklySessionCounts(
    dailySessionCounts(
      sessionLog,
      pastBooked,
      DateTime.now().setZone(ZONE)
    )
  )

  // Colleges tab = 12th-graders only. Gate on the student's grade
  // (Overview C4 "Current Year:" mirror === "12th"), NOT on a 🏫 College List tab:
  // every student gets that tab from day 1 so Ryan can build the list early, so
  // tab-presence both leaks Colleges to underclassmen and hides it from a senior
  // whose tab isn't created yet.
  const { studentName, currentYear } = studentDisplay(student, profile)
  const hasCollegeList = currentYear === '12th'

  // "Project progress" line: always aggregated across 🏆 Comps & Projects —
  // seniors keep working on projects too (college-app progress lives in the
  // Colleges tab, not here). Computed below once activeProjects is built.
  let progress = null

  console.log('Student name:', studentName)

  console.log('7. Project rows found:', projectRows.length)
  console.log('8. All project rows:', JSON.stringify(projectRows))

// Booking tokens (ryan / aaron / art) — authoritative in Supabase
// booking_tokens since the 2026-08-19 cutover; the Master AZ/BB/BD cells are
// dead. Fail SOFT here: on a read error the cards render locked ("Check in to
// unlock"), which a reload fixes — better than 500ing the whole home payload.
let bookingTokens = { ryan: '', aaron: '', art: '' };
try {
  bookingTokens = await getBookingTokens(studentSheetId);
} catch (e) {
  console.error('home-data: booking token read failed (rendering locked):', e?.message || e);
}
const meetingType = bookingTokens.ryan || null;
const aaronLastCheckin = student.last_aaron_checkin ?? null; // was Master BA
const aaronMeetingType = bookingTokens.aaron || null;

// ART eligibility (students.art_eligible, a real boolean) + token (ISO timestamp
// of the last booking, or empty). "Available" iff isART AND (no timestamp OR
// it's older than this week's Saturday).
const isART = student.art_eligible === true;
const artBookingTimestamp = bookingTokens.art || '';

// students.needs_checkin (was Master BE "Needs Checkin") — THE roster-maintained
// answer to "is this student in the weekly check-in cadence at all?" (11 of 47
// are marked out of it). Two other consumers already treat this flag as the
// authority and use exactly this rule — excluded only on an EXPLICIT false, so a
// null (blank cell) stays in the cadence:
// Google Apps Scripts/checkin-reminder/checkinReminder.gs (AD_NEEDS_CHECKIN = 56)
// and app/api/developer/checkinCompliance/route.js:104. The portal reads it so its
// check-in nudge can't contradict the reminder email that same flag already gates.
const needsCheckin = student.needs_checkin !== false;

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

  // Standing weekly project-meeting cards (solo research, etc.) — a separate, additive
  // track surfaced for BOTH seniors and non-seniors. Empty array when the student has
  // no plan. [{ planId, slug, name, minutes, durations, label, window, bookable, bookedThisWeek }].
  const projectMeetings = await projectMeetingCards(studentSheetId, nowLA)

  // Senior essay-program context. When present, the portal swaps the underclassman
  // check-in/15-30 booking UI for the deterministic senior flow. Everything the
  // client needs to render that (without importing the server-only seniors lib).
  const senior = await getSeniorBySheetId(studentSheetId)
  let seniorContext = null
  if (senior) {
    // ONE plan drives both the meetings card and the booking calendar, so they
    // can't disagree. (The old card summarized the *current* Saturday-week while
    // the calendar only offered future days — a late-in-the-week check-in made
    // them contradict, e.g. "Meet Ryan this week" over an empty calendar.)
    const state = await loadSeniorBookingState(senior)
    const plan = seniorBookingPlan(senior, nowLA, state)
    // Durations actually reachable per teacher within the grant window.
    const bookable = { [plan.primarySlug]: [], [plan.secondarySlug]: [] }
    for (const m of plan.meetings) bookable[m.slug] = m.durations
    seniorContext = {
      package: plan.package,
      packageLabel: plan.packageLabel,
      packageNote: plan.packageNote,
      phase: plan.phase,
      primarySlug: plan.primarySlug,
      secondarySlug: plan.secondarySlug,
      primaryName: plan.primaryName,
      secondaryName: plan.secondaryName,
      denominations: plan.denominations,
      maxPerWeek: plan.maxPerWeek,
      bookable,
      meetings: plan.meetings, // [{ slug, name, kind, durations, window:{start,end} }]
      // Separate, additive one-off "extra meeting" grants (admin-issued). Shown as
      // their own cards; bookable even when there's no weekly check-in this week.
      oneoffs: plan.oneoffs, // [{ id, slug, name, kind:'oneoff', minutes, durations, window }]
      thisWeek: plan.thisWeek, // actual current Saturday-week {start,end}
      grantWindow: plan.grantWindow,
      carriesCross: plan.carriesCross,
      crossOwed: plan.crossOwed,
      crossDone: plan.crossDone,
      remaining: plan.remaining,
      // TWO distinct signals — do NOT re-conflate them (they answer different
      // questions and diverge by design):
      //   hasGrant          = "is booking unlocked?" — the Supabase grant ledger,
      //                       the actual booking authority. A grant is spendable
      //                       across the current OR next Saturday-week
      //                       (seniorsCore.js grantWindow), so a senior who
      //                       checked in last week still has a live grant (and any
      //                       owed phase-week cross-meeting) this week. The
      //                       meetings page gates its bookable cards on THIS, so a
      //                       carried grant isn't walled behind "check in to unlock".
      //   checkedInThisWeek = "do you still owe THIS Saturday-week's check-in?" —
      //                       students.last_ryan_checkin (was Master AY) vs the
      //                       current Saturday-week, LA-pinned (timezone-safe). The
      //                       check-in FORM gate, the /check-ins card, and the dock
      //                       nudge read THIS, so a carried 2-week grant does NOT
      //                       suppress next week's check-in. (Collapsing both into
      //                       hasGrant — the 7/8 ecabc3a/a90179f fix — let a Saturday
      //                       check-in's grant block the following week's check-in
      //                       while the weekly reminder still nagged: same signal,
      //                       opposite answers.)
      //                       The reminder GAS uses a rolling-7-day window (not this
      //                       Saturday-week); they agree in the common case incl.
      //                       that bug, and late-week boundary diffs are benign.
      hasGrant: plan.hasGrant,
      checkedInThisWeek: checkedInThisWeek(student.last_ryan_checkin, nowLA),
    }
  }

  return Response.json({
    activeProjects,
    studentName,
    lastCheckin: student.last_ryan_checkin ?? null, // was Master AY
    meetingType,
    aaronLastCheckin,
    aaronMeetingType,
    needsCheckin,
    isART,
    artTokenAvailable,
    hasCollegeList,
    scores,
    progress,
    sessions,
    senior: seniorContext,
    projectMeetings,
  })
}
