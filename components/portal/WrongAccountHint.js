'use client';

import Link from 'next/link';
import { useUser } from '@clerk/nextjs';
import { useClerk } from '@clerk/nextjs';

// "Student not found" means the signed-in email isn't on the roster — almost
// always the wrong Google account, not a missing record. This renders INSIDE the
// existing error cards, because that is where the affected student already is;
// making them navigate somewhere to learn which account they're in is the same
// dead end one step later.
//
// Naming the address is the whole point. A letter-avatar can't do this job: both
// of the 2026-08-21 student's Google accounts began with the same letter, so only
// the literal address distinguishes them.
//
// GATED on the identity error specifically: showing "check which account you're
// in" during a Sheets outage would be a confident wrong answer, and two surfaces
// must never make contradictory promises about the same state.
const isIdentityError = (err) => /not found/i.test(String(err ?? ''));

export default function WrongAccountHint({ error }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { signOut } = useClerk();

  if (!isIdentityError(error)) return null;

  const email = isLoaded && isSignedIn ? user.primaryEmailAddress?.emailAddress : null;

  return (
    <div className="mt-4 border-t border-sand/60 pt-4 text-left">
      <p className="text-sm leading-relaxed text-ink-soft">
        You’re signed in as{' '}
        {email ? (
          <span className="break-all font-semibold text-ink">{email}</span>
        ) : (
          'this device’s Google account'
        )}
        . If that isn’t the address we have on file, that’s the problem — nothing has
        been deleted.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => signOut({ redirectUrl: '/sign-in' })}
          className="inline-flex min-h-11 items-center rounded-xl text-sm font-semibold text-terracotta-deep underline underline-offset-2 transition hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          Not you? Sign out
        </button>
        <Link
          href="/account"
          className="inline-flex min-h-11 items-center rounded-xl text-sm font-semibold text-ink-soft underline underline-offset-2 transition hover:text-ink hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          Account details
        </Link>
      </div>
    </div>
  );
}
