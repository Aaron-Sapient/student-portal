import { DateTime } from 'luxon'
import { getSupabaseClient, MEETINGS_TABLE } from '@/lib/supabase'

// The 📆 Meetings LOG (what was discussed / assigned) — NOT the booking tables.
// Read side for the staff page + the write side the portal owns for students whose
// `students.meetings_source = 'portal'` (the per-student booster; see
// supabase/meetings_portal_source.sql). Server-only: uses the service-role client.

export const ZONE = 'America/Los_Angeles'
export const EDITABLE_FIELDS = ['meeting_date', 'teacher', 'project', 'agenda', 'homework', 'hw_status', 'pct']
export const TEACHERS = ['Aaron', 'Ryan']

export function todayLA() {
  return DateTime.now().setZone(ZONE).toISODate()
}

export async function studentBySlug(slug) {
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from('students')
    .select('id, slug, name, class, student_sheet_id, meetings_source, portal_url')
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export async function studentById(id) {
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from('students')
    .select('id, slug, name, class, student_sheet_id, meetings_source')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data || null
}

// Newest first; undated rows sink to the bottom (Postgres DESC would float NULLs up).
export async function listMeetings(studentSheetId) {
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from(MEETINGS_TABLE)
    .select('id, seq, meeting_date, teacher, project, agenda, homework, hw_status, pct, source, updated_at')
    .eq('student_sheet_id', studentSheetId)
    .is('voided_at', null)
    .order('meeting_date', { ascending: false, nullsFirst: false })
    .order('seq', { ascending: false })
    .range(0, 9999)
  if (error) throw error
  return data || []
}

// Atomic find-or-create for (student, day, teacher) — the SQL function holds a
// per-student advisory lock, so a double-click or two tabs can neither duplicate
// the row nor collide on `seq`. Throws if the student isn't portal-owned.
export async function meetingForDay(studentSheetId, date, teacher) {
  const sb = getSupabaseClient()
  const { data, error } = await sb.rpc('portal_meeting_for_day', {
    p_sheet_id: studentSheetId,
    p_date: date,
    p_teacher: teacher,
  })
  if (error) throw error
  return data
}

// Build the patch FROM the allowlist (never from the body's keys), so id /
// student_sheet_id / seq / source can never be written by a caller.
export function sanitizePatch(fields) {
  const patch = {}
  for (const k of EDITABLE_FIELDS) {
    if (!(k in (fields || {}))) continue
    let v = fields[k]
    if (v === '') v = null
    if (v != null && typeof v !== 'string') return { error: `${k} must be a string` }
    if (k === 'meeting_date' && v != null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: 'meeting_date must be YYYY-MM-DD' }
    if (k === 'teacher' && v != null && !TEACHERS.includes(v)) return { error: 'teacher must be Aaron or Ryan' }
    if (k === 'hw_status' && v != null) v = v.trim().toLowerCase()
    patch[k] = v
  }
  if (!Object.keys(patch).length) return { error: 'nothing to update' }
  return { patch }
}

// Ownership is checked server-side from the ROW (not the body): the row's student
// must be portal-owned, and only portal-written rows are editable.
export async function ownedPortalRow(id) {
  const sb = getSupabaseClient()
  const { data: row, error } = await sb
    .from(MEETINGS_TABLE)
    .select('id, student_sheet_id, source, voided_at')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!row) return { status: 404, error: 'No such meeting' }
  const { data: st } = await sb
    .from('students')
    .select('meetings_source')
    .eq('student_sheet_id', row.student_sheet_id)
    .maybeSingle()
  if (st?.meetings_source !== 'portal') return { status: 403, error: 'This student’s log still lives in the sheet' }
  return { row }
}

export async function updateMeeting(id, patch) {
  const sb = getSupabaseClient()
  const { data, error } = await sb
    .from(MEETINGS_TABLE)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, seq, meeting_date, teacher, project, agenda, homework, hw_status, pct, source, updated_at')
    .single()
  if (error) throw error
  return data
}

export async function voidMeeting(id) {
  const sb = getSupabaseClient()
  const { error } = await sb
    .from(MEETINGS_TABLE)
    .update({ voided_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}
