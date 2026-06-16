import { DateTime } from 'luxon'

const ZONE = 'America/Los_Angeles'

// 🏆 Comps & Projects date cell (UNFORMATTED_VALUE: Sheets serial number or
// string) → LA calendar date, or null.
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

// The portal's definition of an active project, shared by /api/home-data and
// /api/parent/home-data. A row from '🏆 Comps & Projects'!E:N is active iff
// BOTH hold (a 🟢 alone or a date range alone is not enough):
//   - Status (col K) is 🟢
//   - the date range is explicitly active: End (col G) is present and
//     today-or-later, and Start (col F), when present, is today-or-earlier
// The admin report (lib/generateReport.js) intentionally uses a looser,
// yearly notion and does not belong here.
export function activeProjectsFromRows(rows) {
  const today = DateTime.now().setZone(ZONE).startOf('day')
  return (rows || [])
    .slice(1) // header
    .filter((row) => {
      if (String(row[6] ?? '').trim() !== '🟢') return false
      const end = toLADate(row[2])
      if (!end || end.startOf('day') < today) return false
      const start = toLADate(row[1])
      return !start || start.startOf('day') <= today
    })
    .map((row) => ({
      name: row[0],
      endDate: row[2],
      progress: row[4],
      link: row[8],
      owner: row[9] || null, // col N: 'Ryan' | 'Aaron' | null — gates write-back
    }))
}
