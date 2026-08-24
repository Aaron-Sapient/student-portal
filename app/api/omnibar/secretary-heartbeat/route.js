import { authorizedOmnibar } from '@/lib/omnibarAuth'
import { getSupabaseClient } from '@/lib/supabase'

// Liveness feed for the NAS `ap-secretary-watchdog` container.
//
// The Secretary runs on Ryan's Mini (07h/13h PT) and ships one secretary_runs row per
// full run, so a stale newest row means it is down. The watchdog used to read that row
// from Supabase directly, using credentials it took from the omnibar's portal.env. On
// 2026-08-22 that file was deliberately emptied of Supabase credentials so the NAS holds
// none -- which silently blinded the watchdog (KeyError: 'SUPABASE_URL') and left it
// emailing a query-failure alert once a day instead of actually watching anything.
//
// Same shape as portal-index: the NAS holds only OMNIBAR_READ_TOKEN, never a DB key.
export const dynamic = 'force-dynamic'

export async function GET(request) {
  if (!authorizedOmnibar(request)) return new Response('Unauthorized', { status: 401 })
  try {
    const sb = getSupabaseClient()
    const { data, error } = await sb
      .from('secretary_runs')
      .select('run_id, ts, mode')
      .order('ts', { ascending: false })
      .limit(1)
    if (error) throw error

    const newest = data?.[0] || null
    // age_hours is computed HERE, so the watchdog needs no clock skew handling and no
    // timestamp parsing of its own -- it only compares a number to its threshold.
    const ageHours = newest
      ? (Date.now() - new Date(newest.ts).getTime()) / 3_600_000
      : null

    return Response.json(
      {
        ok: true,
        newest_run_id: newest?.run_id ?? null,
        newest_ts: newest?.ts ?? null,
        mode: newest?.mode ?? null,
        age_hours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
        empty: !newest,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e) {
    console.error('omnibar/secretary-heartbeat', e?.message || e)
    return Response.json({ ok: false, error: 'secretary heartbeat unavailable' }, { status: 503 })
  }
}
