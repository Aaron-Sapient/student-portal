import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// The /write/<docId> word-processor + its doc-level APIs are public: possession
// of the unguessable doc/tab UUID is the capability, so a student can open and
// edit their essays with NO account or login (Aaron, 2026-06-19 — "widen the moat
// now, shrink it later"). Auth, when a session DOES exist, still resolves for
// proper attribution (lib/writingAuth.resolveActorOrLink). The student-MAP route
// (/api/writing, keyed by the semi-enumerable Sheet id) is deliberately NOT here.
// The /api/cron/* jobs are Clerk-public because a SCHEDULED invocation has no
// session to protect: they authenticate with a CRON_SECRET bearer instead
// (lib/cronAuth.js requireCron, which fails closed). Without this allowlist entry
// auth.protect() 404s them before their own guard ever runs.
// /demo is a baked, fictional-student sample of the family portal, shown on the
// office TV during proposal meetings. It reads no table, sheet or session, so
// there is nothing for auth to protect — and a login wall in front of a demo is
// the demo failing in the room.
// /next/<lead-slug> is the per-lead post-consult page, opened from an email by a
// family who has no account and will never have one. Public on the same terms as
// /write: possession of the unguessable `<lead>-<6 hex>` slug IS the capability,
// which is why the slug is not just a first name (the page carries prices). The
// page is read-only and writes nothing. The trailing SLASH is load-bearing:
// `/next(.*)` would also publish any future /next-steps or /nextcloud, so only
// the id space under /next/ is public.
// /api/next/* serves that same page: the slots it offers and the booking it
// takes. Same credential, same reasoning — the slug is in the request and the
// routes 404 an unknown one, so they cannot be used to enumerate leads either.
const isPublicRoute = createRouteMatcher(['/demo(.*)', '/sign-in(.*)', '/sso-callback(.*)', '/parents(.*)', '/api/parentCheckin', '/write(.*)', '/next/(.*)', '/api/next/(.*)', '/api/writing/doc', '/api/writing/save', '/api/writing/tab', '/api/writing/history', '/sat(.*)', '/api/sat/init', '/api/sat/quiz', '/api/sat/submit', '/api/cron(.*)', '/api/omnibar(.*)'])

// next.admissions.partners serves the lead pages from its ROOT, so on that host
// the path is `/conor` and the matcher above (which knows about `/next/…`) never
// fires. The middleware sees the ORIGINAL path, not the rewritten one, so the
// host has to be checked here rather than inferred from the destination.
//
// Scoped to ONE path segment matching the slug shape, and only on those hosts:
// this must never widen what is public on portal.admissions.partners, where a
// bare `/:slug` rule would unauthenticate a great deal more than a lead page.
// `/api/*` is excluded by the segment rule (it has two) and is already covered
// above, so the API works identically from either host.
//
// MOVED 2026-09-09: the lead host is next.admissions.partners. The retired
// book.ryanchoice.com stays in this list on purpose. next.config's redirects run
// BEFORE middleware, so in practice the old host 308s and never reaches here at
// all; keeping it means that if that ordering ever changes, a family holding an
// already-sent link gets their page rather than a sign-in wall. It widens
// nothing relative to what that host already served.
const BOOK_HOST = 'next.admissions.partners'
const RETIRED_BOOK_HOST = 'book.ryanchoice.com'
const BOOK_SLUG = /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/

function isBookHostLeadPage(request) {
  const host = request.headers.get('host')?.split(':')[0].toLowerCase()
  if (host !== BOOK_HOST && host !== RETIRED_BOOK_HOST) return false
  return BOOK_SLUG.test(new URL(request.url).pathname)
}

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request) && !isBookHostLeadPage(request)) {
    await auth.protect()
  }
}, { signInUrl: '/sign-in' })

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}