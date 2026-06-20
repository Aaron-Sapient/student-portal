// Per-domain read-source flags for the Sheets→Supabase migration (Step B).
// See _notes/cutover-field-map.md §E. Each data DOMAIN (scores, roster, …) reads
// its own env var so reads cut over one domain at a time, never big-bang:
//
//   READ_SUPABASE_<DOMAIN> = off | shadow | on        (unset ⇒ off)
//
//   off    → Google Sheets only — today's behavior, Supabase untouched. The
//            default, so prod/Vercel is byte-for-byte unchanged until a flag is
//            explicitly set.
//   shadow → read BOTH sources, RETURN the authoritative Sheets answer, and log
//            any field-level diff. This is how we "verify each value against
//            Sheets before flipping" — prod keeps serving Sheets while we gather
//            parity evidence.
//   on     → Supabase only (the Sheets read is skipped — the quota win lands here).
//
// The flag is per-domain, NOT per-route: one route (e.g. home-data) reads several
// domains and consults each flag independently, so it can run half-Supabase /
// half-Sheets during the transition.

const MODES = new Set(['off', 'shadow', 'on'])

export function readMode(domain) {
  const mode = String(process.env[`READ_SUPABASE_${domain.toUpperCase()}`] ?? '')
    .trim()
    .toLowerCase()
  return MODES.has(mode) ? mode : 'off'
}

// One-line shadow-mode log. `diffs` is an array of human-readable mismatch
// strings; empty ⇒ the two sources agreed. Never throws — shadow mode must never
// affect the response or take down a request.
export function logShadow(domain, key, diffs) {
  try {
    if (diffs && diffs.length) {
      console.warn(`[shadow:${domain}] ${key} MISMATCH — ${diffs.join(' · ')}`)
    } else {
      console.log(`[shadow:${domain}] ${key} ✓`)
    }
  } catch {
    /* logging must never throw */
  }
}
