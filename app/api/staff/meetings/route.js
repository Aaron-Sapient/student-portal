import { requireAdmin, teacherForEmail } from '@/lib/developerAuth'
import {
  studentById,
  meetingForDay,
  sanitizePatch,
  ownedPortalRow,
  updateMeeting,
  voidMeeting,
  todayLA,
} from '@/lib/meetingsLog'

// Staff write path for the 📆 Meetings LOG of a portal-owned student
// (students.meetings_source='portal'). Every branch re-derives ownership from the
// database — the body only names a student id / row id, never a sheet id.
//   POST   { studentId, date? }            → find-or-create today's row for ME → { meeting }
//   PATCH  { id, fields }                  → update allowlisted fields         → { meeting }
//   DELETE { id }                          → soft-void (the undo path)         → { ok }

export async function POST(request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  const teacher = teacherForEmail(gate.email)
  if (!teacher) return Response.json({ error: `No instructor mapped for ${gate.email}` }, { status: 403 })

  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Bad JSON' }, { status: 400 }) }
  const student = body?.studentId ? await studentById(String(body.studentId)) : null
  if (!student) return Response.json({ error: 'Unknown student' }, { status: 404 })
  if (student.meetings_source !== 'portal') {
    return Response.json({ error: 'This student’s log still lives in the sheet' }, { status: 403 })
  }
  const date = body.date ? String(body.date) : todayLA()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })
  try {
    const meeting = await meetingForDay(student.student_sheet_id, date, teacher)
    return Response.json({ meeting })
  } catch (e) {
    console.error('staff/meetings POST', e?.message || e)
    return Response.json({ error: 'Could not create the meeting' }, { status: 500 })
  }
}

export async function PATCH(request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Bad JSON' }, { status: 400 }) }
  if (!body?.id) return Response.json({ error: 'Missing id' }, { status: 400 })
  const { patch, error } = sanitizePatch(body.fields)
  if (error) return Response.json({ error }, { status: 400 })
  const own = await ownedPortalRow(String(body.id))
  if (own.error) return Response.json({ error: own.error }, { status: own.status })
  try {
    const meeting = await updateMeeting(own.row.id, patch)
    return Response.json({ meeting })
  } catch (e) {
    console.error('staff/meetings PATCH', e?.message || e)
    return Response.json({ error: 'Could not save' }, { status: 500 })
  }
}

export async function DELETE(request) {
  const gate = await requireAdmin()
  if (!gate.ok) return gate.response
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Bad JSON' }, { status: 400 }) }
  if (!body?.id) return Response.json({ error: 'Missing id' }, { status: 400 })
  const own = await ownedPortalRow(String(body.id))
  if (own.error) return Response.json({ error: own.error }, { status: own.status })
  // Only portal-written rows can be voided: sheet-mirrored history is read-only here.
  if (own.row.source !== 'portal') return Response.json({ error: 'Sheet-mirrored rows are read-only' }, { status: 403 })
  try {
    await voidMeeting(own.row.id)
    return Response.json({ ok: true })
  } catch (e) {
    console.error('staff/meetings DELETE', e?.message || e)
    return Response.json({ error: 'Could not remove' }, { status: 500 })
  }
}
