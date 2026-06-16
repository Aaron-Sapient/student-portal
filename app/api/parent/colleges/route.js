import { requireParent } from '@/lib/identity'
import { fetchCollegeData } from '@/lib/collegeList'

export async function GET(request) {
  const { child, sheets, error } = await requireParent(request)
  if (error) return error

  const payload = await fetchCollegeData(sheets, child.sheetId)
  if (!payload) return Response.json({ error: 'No college list yet' }, { status: 404 })
  return Response.json(payload)
}
