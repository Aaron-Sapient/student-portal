import { auth } from '@clerk/nextjs/server'
import { notFound, redirect } from 'next/navigation'
import PortalShell from '@/components/portal/PortalShell'
import { ADMIN_EMAILS, teacherForEmail } from '@/lib/developerAuth'
import { sessionEmail, normEmail } from '@/lib/identity'
import { studentBySlug, listMeetings, meetingForDay, todayLA } from '@/lib/meetingsLog'
import MeetingsLog from './MeetingsLog'

// /[student]/meetings — the first `/[student]/…` route (slug = students.slug, the same
// string as the omnibar address; W11). Staff-only for now: a student hitting their own
// slug gets a 404 (v2 opens it as a permission mask over the same route).
//
// `?new=today` is the omnibar's "New meeting" deep link: find-or-create today's row for
// the signed-in instructor (atomic, per-student lock — double-open is safe), then
// redirect to the clean URL with `?focus=<id>` so a reload never re-runs the write.
export const dynamic = 'force-dynamic'

export default async function StudentMeetingsPage({ params, searchParams }) {
  const { student: slug } = await params
  const sp = await searchParams
  const { sessionClaims } = await auth()
  const email = normEmail(sessionEmail(sessionClaims))
  if (!ADMIN_EMAILS.includes(email)) {
    console.warn(`[student/meetings] non-staff session refused: ${email || '(no email claim)'}`)
    notFound()
  }

  const student = await studentBySlug(slug)
  if (!student) notFound()
  const portalOwned = student.meetings_source === 'portal'
  const me = teacherForEmail(email)

  if (sp?.new === 'today' && portalOwned && me) {
    const row = await meetingForDay(student.student_sheet_id, todayLA(), me)
    redirect(`/${student.slug}/meetings?focus=${row.id}`)
  }

  const meetings = await listMeetings(student.student_sheet_id)

  return (
    <PortalShell iconNames="calendar_month">
      <main className="relative z-10 mx-auto w-full max-w-3xl px-5 pb-24 pt-8 sm:px-7">
        <MeetingsLog
          student={{ id: student.id, slug: student.slug, name: student.name, klass: student.class, portalUrl: student.portal_url }}
          portalOwned={portalOwned}
          me={me}
          today={todayLA()}
          initial={meetings}
          focusId={typeof sp?.focus === 'string' ? sp.focus : null}
        />
      </main>
    </PortalShell>
  )
}
