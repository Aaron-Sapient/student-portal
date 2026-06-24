// Stable, link-safe base URL for anything we put in an outbound email.
//
// Why this exists: NEXT_PUBLIC_BASE_URL has repeatedly been set to a
// *deployment-specific* Vercel URL (e.g. student-portal-9o7r034rf-….vercel.app).
// Vercel's deployment-retention policy garbage-collects those, so any link we
// already emailed later dies with a "410: GONE" and the student can't book. The
// production alias (portal.admissions.partners) and a custom dev host (e.g. the
// tailscale MagicDNS name) never rot — so we ignore any *.vercel.app value and
// fall back to the canonical prod domain.
const CANONICAL = 'https://portal.admissions.partners';

export function emailBaseUrl() {
  const raw = (process.env.NEXT_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!raw) return CANONICAL;
  try {
    // Any *.vercel.app host is a per-deployment URL Vercel will delete; never
    // bake one into an email. A custom domain is stable and honored as-is.
    if (new URL(raw).hostname.endsWith('.vercel.app')) return CANONICAL;
  } catch {
    return CANONICAL;
  }
  return raw;
}
