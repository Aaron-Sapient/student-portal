import { authorizedOmnibar } from '@/lib/omnibarAuth'
import { getSupabaseClient } from '@/lib/supabase'

// The AP omnibar's ROSTER feed (AP-Counseling/06. Scripts/omnibar/build_index.py::fetch_roster).
// Student + guardian emails for the omnibar's Email List panel, straight off the Supabase roster
// (`students` + `guardians`). Aaron's ruling 2026-09-10: those surfaces are decoupled from Google —
// the omnibar never reads the Master Sheet, and Sheets reaches these tables only through the
// reconcile cron (scripts/backfillStudents.cjs).
//
// Second member of the /api/omnibar/* family, so it inherits the same server-to-server contract as
// portal-index: one app-level bearer token on the calling machines, no Supabase credential anywhere
// but here. Already public in proxy.js via '/api/omnibar(.*)'; authorization is the header check.
// One SQL function does the whole read (supabase/omnibar_roster.sql).
export const dynamic = 'force-dynamic'

export async function GET(request) {
  if (!authorizedOmnibar(request)) return new Response('Unauthorized', { status: 401 })
  try {
    const sb = getSupabaseClient()
    const { data, error } = await sb.rpc('omnibar_roster')
    if (error) throw error
    return Response.json({ rows: data || [], built: new Date().toISOString() }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    console.error('omnibar/roster', e?.message || e)
    return Response.json({ error: 'roster unavailable' }, { status: 503 })
  }
}
