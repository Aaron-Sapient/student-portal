import { SignIn } from '@clerk/nextjs'

// oidcPrompt="select_account" → always show Google's account chooser.
//
// Unconditional, deliberately. Google's own default already shows a chooser when
// the browser holds MULTIPLE Google sessions; the case it does NOT is exactly one
// session, where it silently auto-continues. That single-session case is what
// stranded a student on 2026-08-21: her phone held one Google account (her
// school's), so signing out of Clerk just handed the same account straight back
// and every route kept 404ing "Student not found".
//
// So the only users who see an extra step here are single-account users — the
// same ones who otherwise have no route to "Use another account" at all. Scoping
// this behind a query flag was tried and reverted: the flag is lost on session
// expiry, on a bookmarked /sign-in, and via Clerk's hosted account portal, i.e.
// precisely when someone is stuck and needs it most.
//
// Clerk passes this through to the OIDC `prompt` parameter in the generated OAuth
// redirect (SignInProps.oidcPrompt, @clerk/shared 4.4.0). No custom Google
// credentials, no dashboard change.
export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <SignIn oidcPrompt="select_account" />
    </div>
  )
}
