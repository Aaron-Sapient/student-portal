import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// The /write/<docId> word-processor + its doc-level APIs are public: possession
// of the unguessable doc/tab UUID is the capability, so a student can open and
// edit their essays with NO account or login (Aaron, 2026-06-19 — "widen the moat
// now, shrink it later"). Auth, when a session DOES exist, still resolves for
// proper attribution (lib/writingAuth.resolveActorOrLink). The student-MAP route
// (/api/writing, keyed by the semi-enumerable Sheet id) is deliberately NOT here.
const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sso-callback(.*)', '/parents(.*)', '/api/parentCheckin', '/checkin-approval(.*)', '/api/checkinDecision', '/write(.*)', '/api/writing/doc', '/api/writing/save', '/api/writing/tab', '/api/writing/history'])

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect()
  }
}, { signInUrl: '/sign-in' })

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}