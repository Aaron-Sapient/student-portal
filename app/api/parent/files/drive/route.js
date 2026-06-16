import { requireParent } from '@/lib/identity'
import { resolveStudentFolderId, streamDriveFileFromFolder } from '@/lib/studentFiles'

// Parent-scoped Drive proxy: same own-folder membership gate as the student
// version, but the folder is resolved from the parent's validated child.
export async function GET(request) {
  const { child, sheets, error } = await requireParent(request)
  if (error) return error

  const fileId = new URL(request.url).searchParams.get('id')
  if (!fileId) return new Response('Missing id', { status: 400 })

  const folderId = await resolveStudentFolderId(sheets, child.sheetId)
  if (!folderId) return new Response('Not found', { status: 404 })

  return streamDriveFileFromFolder(folderId, fileId)
}
