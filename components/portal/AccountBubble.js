'use client';

import Link from 'next/link';
import { useUser } from '@clerk/nextjs';

// The "which account am I in?" affordance. Deliberately NOT a dock tab: the dock
// carries the five things a student does weekly, and burying a rarely-used
// account control in it would cost a tab slot and dilute the nav. Deliberately
// NOT inside PortalShell either — that shell is shared with /sat and /write,
// which are PUBLIC (proxy.js isPublicRoute) and have no signed-in user at all.
//
// Placement: upper-left on phones, lower-left from md up. On a phone the dock
// owns the bottom (thumb zone), so a bottom-left bubble would crowd the one
// control students use constantly; the top-left corner is the hard-reach corner,
// which is exactly right for something you touch twice a year. From md up the
// dock is `mx-auto max-w-md` (448px, centered), so the bottom-left corner is
// empty and the bubble sits out of the reading column.
//
// Built 2026-08-21 after a student signed in with her school Google account,
// got "Student not found" on every tab, and had no way to sign out — the app
// had zero sign-out UI anywhere.
export default function AccountBubble() {
  const { isLoaded, isSignedIn, user } = useUser();

  // Render nothing until Clerk resolves: a bubble that pops in with the wrong
  // initial and then corrects itself is worse than one that arrives late.
  if (!isLoaded || !isSignedIn) return null;

  const email = user.primaryEmailAddress?.emailAddress || '';
  const display = (user.fullName || user.firstName || email).trim();
  const initial = (display.match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();

  return (
    <Link
      href="/account"
      aria-label={`Account — signed in as ${email || display}`}
      title={email || display}
      className="neu-raised portal-account-bubble fixed z-20 grid h-11 w-11 place-items-center rounded-full font-display text-base font-semibold text-ink-soft transition-[transform,color] duration-200 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-cream active:scale-95"
    >
      <span aria-hidden>{initial}</span>
    </Link>
  );
}
