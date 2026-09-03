import { getStudentProfile, requireParent, studentDisplay } from '@/lib/identity'
import { getGoogleCalendarClient } from '@/lib/google'

// Read-only upcoming meetings for the validated child — same title-match
// logic as the student route (/api/getUpcomingMeetings), but parent-gated and
// VIEW-ONLY BY CONSTRUCTION: the payload carries no event ids and no titles,
// so nothing here can feed the cancel/reschedule endpoints.
export async function GET(request) {
  const { email, child, error } = await requireParent(request)
  if (error) return error

  try {
    // Canonical name for the title match. bookMeeting builds event titles from
    // 🔎 Overview!B2, which student_profiles.display_name mirrors VERBATIM (trailing
    // space included — see lib/checkinIdentity.js for why that spelling is
    // load-bearing). getStudentProfile never throws; a missing row degrades to the
    // roster name, exactly as the old try/catch around the sheet read did.
    const profile = await getStudentProfile(child.sheetId)
    const { studentName } = studentDisplay({ name: child.name }, profile)
    if (!studentName) return Response.json({ meetings: [] })

    const calendar = getGoogleCalendarClient(email)
    const now = new Date()
    const eightWeeksOut = new Date(now.getTime() + 8 * 7 * 24 * 60 * 60 * 1000)
    const search = studentName.toLowerCase().trim()

    async function fetchFromCalendar(calendarId, instructorName) {
      const res = await calendar.events.list({
        calendarId,
        timeMin: now.toISOString(),
        timeMax: eightWeeksOut.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      })
      return (res.data.items || [])
        .filter(
          (e) =>
            e.status !== 'cancelled' &&
            e.summary &&
            e.summary.toLowerCase().includes(search)
        )
        .map((e) => {
          const isArt =
            e.extendedProperties?.private?.bookingType === 'art' ||
            e.summary.startsWith('ART:')
          return {
            start: e.start.dateTime || e.start.date,
            end: e.end.dateTime || e.end.date,
            description: e.description || '',
            instructor: isArt ? 'ART' : instructorName,
          }
        })
    }

    const [ryans, aarons] = await Promise.all([
      fetchFromCalendar(process.env.GOOGLE_CALENDAR_ID_RYAN, 'Ryan'),
      fetchFromCalendar(process.env.GOOGLE_CALENDAR_ID_AARON, 'Aaron'),
    ])

    const meetings = [...ryans, ...aarons].sort(
      (a, b) => new Date(a.start) - new Date(b.start)
    )
    return Response.json({ meetings })
  } catch (err) {
    console.error('parent/meetings error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
