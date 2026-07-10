import { requireParent } from '@/lib/identity'
import { processParentCheckin } from '@/lib/parentCheckinCore'

// Authenticated parent check-in: the email comes from the verified Clerk
// session (the request body's email — if any — is never read), and the child is
// validated via ?student=<sheetId> so the student name is known, not inferred.
export async function POST(request) {
  const { email, child, error } = await requireParent(request)
  if (error) return error

  try {
    const { concern } = await request.json()
    if (!concern || !String(concern).trim()) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 })
    }
    const result = await processParentCheckin({
      parentEmail: email,
      concern: String(concern),
      knownStudentName: child.name,
      knownSheetId: child.sheetId,
    })
    return Response.json(result)
  } catch (err) {
    console.error('parent/checkin error:', err)
    return Response.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
