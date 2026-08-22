import { timingSafeEqual } from 'node:crypto'
import { getSupabaseClient } from '@/lib/supabase'

// The AP omnibar's portal-docs feed (AP-Counseling/06. Scripts/omnibar/build_index.py::fetch_portal).
// Server-to-server: the omnibar copies (Aaron's Mac, the NAS, Ryan's Mini) hold ONLY this app-level
// bearer token — no Supabase credential at all — which is what lets the project's legacy JWT secret
// be revoked (RLS downgrade, durable form, 2026-08-22). Listed in proxy.js isPublicRoute so Clerk
// doesn't 404 it; authorization is this header check. One SQL function does the whole read
// (supabase/omnibar_portal_index.sql) and returns the exact row shape build_index expects.
export const dynamic = 'force-dynamic'

function authorized(request) {
  const expected = process.env.OMNIBAR_READ_TOKEN || ''
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!expected || !got || got.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}

export async function GET(request) {
  if (!authorized(request)) return new Response('Unauthorized', { status: 401 })
  try {
    const sb = getSupabaseClient()
    const { data, error } = await sb.rpc('omnibar_portal_index')
    if (error) throw error
    return Response.json({ rows: data || [], built: new Date().toISOString() }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    console.error('omnibar/portal-index', e?.message || e)
    return Response.json({ error: 'portal index unavailable' }, { status: 503 })
  }
}
