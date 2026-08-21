'use client';

import { useClerk } from '@clerk/nextjs';

// Before this existed, a throw in any portal layout (resolveIdentity can throw on
// a Sheets 429 or a Supabase blip — lib/identity.js) rendered Next's default error
// page: no shell, no nav, and critically no way to sign out. The whole bug class
// this was written alongside is "the user is stuck with no exit", so the exit
// belongs here too.
export default function AppError({ error, reset }) {
  const { signOut } = useClerk();
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-5 px-6 py-16 text-center">
      <h1 className="font-display text-2xl font-semibold text-ink">Something went wrong</h1>
      <p className="text-sm leading-relaxed text-ink-soft">
        This one’s on us, not on you. Try again — and if it keeps happening, signing out
        and back in clears most of it.
      </p>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="min-h-11 rounded-2xl bg-terracotta px-5 py-3 text-sm font-semibold text-white transition hover:bg-terracotta-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => signOut({ redirectUrl: '/sign-in' })}
          className="min-h-11 rounded-2xl px-5 py-3 text-sm font-semibold text-ink-soft underline underline-offset-2 transition hover:text-ink hover:no-underline"
        >
          Sign out
        </button>
      </div>
      {error?.digest && (
        <p className="text-xs text-ink-faint">Reference: {error.digest}</p>
      )}
    </div>
  );
}
