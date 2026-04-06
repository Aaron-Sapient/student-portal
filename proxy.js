import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sso-callback(.*)'])

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect()
  }
}, { signInUrl: '/sign-in' })

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)'],
}