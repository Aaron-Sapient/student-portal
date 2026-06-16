import { requireParent } from '@/lib/identity'
import { listStudentFiles } from '@/lib/studentFiles'

export async function GET(request) {
  const { child, sheets, error } = await requireParent(request)
  if (error) return error

  const payload = await listStudentFiles(sheets, child.sheetId, {
    // HTML files proxy through the parent-scoped drive route, which re-validates
    // the child on every fetch.
    driveProxyBase: `/api/parent/files/drive?student=${child.sheetId}&`,
    // Parents can't edit — editable files render the child's canonical version
    // read-only (new tab), so they're presented as ordinary reports.
    editableUrlBase: `/api/parent/files/editable?student=${child.sheetId}&`,
    editableInteractive: false,
  })
  return Response.json(payload)
}
