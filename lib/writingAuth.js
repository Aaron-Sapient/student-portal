import { auth } from '@clerk/nextjs/server'
import { getGoogleSheetsClient } from '@/lib/google'
import {
  normEmail,
  sessionEmail,
  resolveIdentity,
  studentBySheetId,
} from '@/lib/identity'
import { ADMIN_EMAILS, DEVELOPER_EMAIL } from '@/lib/developerAuth'

// ============================================================================
// lib/writingAuth.js — Clerk-session auth for the writing routes. Resolves the
// acting editor (and, for GET, the target student) server-side so editor
// identity is never trusted from the client. Pairs with lib/writingDocs.js
// (the backend-only storage logic).
// ============================================================================

// The acting user (editor). role: 'admin' (Aaron/Ryan), 'student', or 'parent'.
// ownSheetId is set only for students. Returns { error } (ready Response) on auth
// failure.
export async function resolveActor() {
  const { userId, sessionClaims } = await auth()
  if (!userId) {
    return { error: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const email = normEmail(sessionEmail(sessionClaims))
  const sheets = getGoogleSheetsClient(email)

  if (ADMIN_EMAILS.includes(email)) {
    const name =
      email === DEVELOPER_EMAIL
        ? 'Aaron'
        : email === 'ryan@sapientacademy.com'
          ? 'Ryan'
          : 'Admin'
    return { email, role: 'admin', name, ownSheetId: null, sheets }
  }

  const identity = await resolveIdentity(sheets, email)
  if (identity.role === 'student') {
    const row = identity.studentRow
    const m = String(row?.[6] ?? '').match(/\/d\/([a-zA-Z0-9-_]+)/)
    return {
      email,
      role: 'student',
      name: String(row?.[0] ?? '').trim() || 'Student',
      ownSheetId: m ? m[1] : null,
      sheets,
    }
  }
  if (identity.role === 'parent') {
    return {
      email,
      role: 'parent',
      name: 'Parent',
      ownSheetId: null,
      children: (identity.children || []).map((c) => c.sheetId),
      sheets,
    }
  }
  return { error: Response.json({ error: 'Forbidden' }, { status: 403 }) }
}

// Can this actor edit the given student's docs? Admins (Aaron/Ryan) may edit any
// student; a student only their own sheet. Parents never.
export function canEditStudent(actor, studentSheetId) {
  if (!actor || actor.role === 'parent') return false
  if (actor.role === 'admin') return true
  return actor.role === 'student' && !!studentSheetId && actor.ownSheetId === studentSheetId
}

// Can this actor VIEW the given student's docs? Edit access implies view; a
// parent may view a child they're linked to.
export function canViewStudent(actor, studentSheetId) {
  if (canEditStudent(actor, studentSheetId)) return true
  return (
    actor?.role === 'parent' &&
    !!studentSheetId &&
    (actor.children || []).includes(studentSheetId)
  )
}

// Which student's docs are we showing, and may the actor edit? Students → own
// sheet (edit). Admins → ?student=<sheetId> (edit any). Parents → ?student must
// be one of their children (view-only). Returns { canEdit } so the same view
// endpoints serve all three roles.
export async function resolveViewTarget(request) {
  const actor = await resolveActor()
  if (actor.error) return actor

  if (actor.role === 'student') {
    if (!actor.ownSheetId) {
      return { error: Response.json({ error: 'Invalid portal URL' }, { status: 400 }) }
    }
    return {
      actor,
      studentSheetId: actor.ownSheetId,
      studentEmail: actor.email,
      studentName: actor.name,
      canEdit: true,
      sheets: actor.sheets,
    }
  }

  // admin or parent → a target ?student is required
  const requested = new URL(request.url).searchParams.get('student')
  if (!requested) {
    return { error: Response.json({ error: 'Missing ?student' }, { status: 400 }) }
  }
  if (actor.role === 'parent' && !(actor.children || []).includes(requested)) {
    return { error: Response.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  const info = await studentBySheetId(actor.sheets, requested)
  return {
    actor,
    studentSheetId: requested,
    studentEmail: info?.email || '',
    studentName: info?.name || 'Student',
    canEdit: actor.role === 'admin',
    sheets: actor.sheets,
  }
}
