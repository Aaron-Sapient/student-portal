import { timingSafeEqual } from 'node:crypto'

// Shared bearer gate for the /api/omnibar/* server-to-server feeds.
//
// These endpoints exist so that machines which are NOT this app — the omnibar copies
// on Aaron's Mac, Ryan's Mini, and the NAS, plus the NAS secretary watchdog — can read
// what they need WITHOUT holding a Supabase credential. That is what let the project's
// legacy JWT be revoked (2026-08-22). Each caller holds only OMNIBAR_READ_TOKEN, which
// can reach exactly these feeds and nothing else.
//
// Extracted 2026-08-23 when the secretary-heartbeat feed became a second consumer;
// previously this lived inline in portal-index. One copy, so the two can't drift.
export function authorizedOmnibar(request) {
  const expected = process.env.OMNIBAR_READ_TOKEN || ''
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!expected || !got || got.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}
