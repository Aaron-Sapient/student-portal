// meetings domain read flag — the 📆 Meetings session log (date + teacher).
//
// Two consumer surfaces read that tab today, each its own shape; both cut over
// behind READ_SUPABASE_MEETINGS (off | shadow | on, default off ⇒ Sheets):
//   • home-data  — the 12-week session-frequency strip (A1:C400 → meetingLogRows)
//   • coach note — "had a meeting in the last 7 days?" gate (B2:B)
// Both now read the Supabase `meetings` mirror (date/teacher), populated by
// mirrorStudentHub.cjs. The developer student route already reads `meetings`
// natively (no flag, richer agenda contract) — left untouched.
//
// off-mode is byte-identical to the prior inline reads: each Sheets path below is
// the verbatim read the consumer did before. Date representations differ across
// sources (Sheets serial vs Supabase 'YYYY-MM-DD'), so the shadow comparator diffs
// the DERIVED LA-date surface, never raw cell bytes.
import { DateTime } from 'luxon'
import { readMode, logShadow } from './readFlags.js'
import { getSupabaseClient, MEETINGS_TABLE } from './supabase.js'

const ZONE = 'America/Los_Angeles'

// Sheets serial number or string → LA calendar date (home-data's parser, verbatim).
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

// coach's parser (verbatim) — identical to toLADate but with a JSDate fallback for
// the rare non-ISO string; kept separate so coach's off-mode parse is unchanged.
function parseMeetingDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'number') {
    const utc = DateTime.fromMillis(Math.round((raw - 25569) * 86400 * 1000), { zone: 'utc' })
    if (!utc.isValid) return null
    return DateTime.fromObject({ year: utc.year, month: utc.month, day: utc.day }, { zone: ZONE })
  }
  let dt = DateTime.fromISO(String(raw), { zone: ZONE })
  if (!dt.isValid) dt = DateTime.fromJSDate(new Date(raw)).setZone(ZONE)
  return dt.isValid ? dt : null
}

// 📆 Meetings grids aren't perfectly uniform: most sheets have Date in col B,
// but some start the table at col A. Find the 'Date' header in the first few
// rows and read that column (plus the Teacher column beside it); fall back to
// the col-B convention. Returns [{ date, teacher }] with raw cell values.
// (Moved verbatim from app/api/home-data/route.js.)
export function meetingLogRows(rows) {
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

async function sessionLogFromSheets(sheets, studentSheetId) {
  const res = await sheets.spreadsheets.values
    .get({
      spreadsheetId: studentSheetId,
      range: "'📆 Meetings'!A1:C400",
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
    .catch(() => null)
  return meetingLogRows(res?.data?.values || [])
}

async function sessionLogFromSupabase(studentSheetId) {
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from(MEETINGS_TABLE)
    .select('meeting_date, teacher')
    .eq('student_sheet_id', studentSheetId)
  if (error) throw error // let the dispatcher fall back to Sheets
  return (data || []).map((r) => ({
    date: r.meeting_date,
    teacher: String(r.teacher ?? '').trim().toLowerCase(),
  }))
}

// Canonical consumed surface for shadow diffing: the sorted multiset of
// "isoDate|bucket" for valid, non-future rows (bucket = ryan|aaron, matching
// dailySessionCounts' `teacher === 'ryan' ? R : A`). Compares meaning, not bytes.
function canonicalLog(log, now) {
  return log
    .map(({ date, teacher }) => {
      const dt = toLADate(date)
      if (!dt || dt > now) return null
      return `${dt.toISODate()}|${teacher === 'ryan' ? 'ryan' : 'aaron'}`
    })
    .filter(Boolean)
    .sort()
}

function diffSessionLog(sheetsLog, supaLog) {
  const now = DateTime.now().setZone(ZONE)
  const a = canonicalLog(sheetsLog, now)
  const b = canonicalLog(supaLog, now)
  if (a.length === b.length && a.every((v, i) => v === b[i])) return []
  const setA = new Set(a)
  const setB = new Set(b)
  const onlySheets = a.filter((v) => !setB.has(v))
  const onlySupa = b.filter((v) => !setA.has(v))
  return [`sheet=${a.length} supa=${b.length} · onlySheets=[${onlySheets.slice(0, 4)}] onlySupa=[${onlySupa.slice(0, 4)}]`]
}

// home-data session-frequency strip. Returns [{ date, teacher }] (raw `date`,
// lowercased `teacher`) — the exact shape dailySessionCounts consumes.
export async function getSessionLog(sheets, studentSheetId) {
  const mode = readMode('meetings')
  if (mode === 'on') {
    try {
      return await sessionLogFromSupabase(studentSheetId)
    } catch {
      return sessionLogFromSheets(sheets, studentSheetId)
    }
  }
  const sheetsLog = await sessionLogFromSheets(sheets, studentSheetId)
  if (mode === 'shadow') {
    try {
      const supaLog = await sessionLogFromSupabase(studentSheetId)
      logShadow('meetings', studentSheetId, diffSessionLog(sheetsLog, supaLog))
    } catch (e) {
      logShadow('meetings', studentSheetId, [`supabase error: ${e.message}`])
    }
  }
  return sheetsLog
}

// coach-note gate: true iff the student logged a meeting in the last 7 days.
// Fails closed (false) if the source is missing/unreadable — better to suppress a
// note than show a stale one (the prior coachMessages behavior, preserved).
export async function hadRecentMeeting(sheets, studentSheetId) {
  if (!studentSheetId) return false
  const now = DateTime.now().setZone(ZONE)
  const cutoff = now.minus({ days: 7 }).startOf('day')
  const end = now.endOf('day')
  const inWindow = (raw) => {
    const dt = parseMeetingDate(raw)
    return !!dt && dt >= cutoff && dt <= end
  }
  const mode = readMode('meetings')
  if (mode === 'on') {
    try {
      const log = await sessionLogFromSupabase(studentSheetId)
      return log.some((r) => inWindow(r.date))
    } catch {
      // fall through to the Sheets read below
    }
  }
  let res
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: studentSheetId,
      range: "'📆 Meetings'!B2:B",
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
  } catch {
    return false
  }
  const sheetsHit = (res.data.values || []).some((r) => inWindow(r[0]))
  if (mode === 'shadow') {
    try {
      const log = await sessionLogFromSupabase(studentSheetId)
      const supaHit = log.some((r) => inWindow(r.date))
      logShadow('meetings', studentSheetId, sheetsHit === supaHit ? [] : [`recentMeeting sheet=${sheetsHit} supa=${supaHit}`])
    } catch (e) {
      logShadow('meetings', studentSheetId, [`recentMeeting supabase error: ${e.message}`])
    }
  }
  return sheetsHit
}
