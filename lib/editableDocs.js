import { getSupabaseClient, DOCUMENT_REVISIONS_TABLE } from '@/lib/supabase'
import { readEditableSource } from '@/lib/studentFiles'

// The canonical HTML for an editable document = the student's latest saved
// revision if one exists, otherwise the counselor's untouched original. Used by
// read-only viewers (the parent portal and Aaron's developer panel) — it never
// writes, so a parent/Aaron viewing a never-edited doc won't create rows.
export async function getCanonicalEditableHtml(sheets, studentSheetId, filename) {
  const supabase = getSupabaseClient()
  const { data } = await supabase
    .from(DOCUMENT_REVISIONS_TABLE)
    .select('html')
    .eq('student_sheet_id', studentSheetId)
    .eq('filename', filename)
    .order('revision', { ascending: false })
    .limit(1)
  if (data?.length) return data[0].html
  return await readEditableSource(sheets, studentSheetId, filename)
}
