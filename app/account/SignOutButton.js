'use client';

import { useState } from 'react';
import { useClerk } from '@clerk/nextjs';
import { LogOut } from 'lucide-react';

// Clerk's own signOut — no bespoke session handling. redirectUrl lands them on
// the sign-in page rather than bouncing through a protected route and back.
export default function SignOutButton({ label = 'Sign out', tone = 'quiet' }) {
  const { signOut } = useClerk();
  const [busy, setBusy] = useState(false);

  const loud =
    'bg-terracotta text-white hover:bg-terracotta-deep shadow-sm';
  const quiet =
    'neu-raised text-ink hover:text-terracotta-deep';

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        // If Clerk throws (offline), re-enable rather than stranding the button
        // in a permanent spinner — this is the one control on the page.
        signOut({ redirectUrl: '/sign-in' }).catch(() => setBusy(false));
      }}
      className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl px-5 py-3 font-body text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60 ${tone === 'loud' ? loud : quiet}`}
    >
      <LogOut className="h-4 w-4" strokeWidth={2} aria-hidden />
      {busy ? 'Signing out…' : label}
    </button>
  );
}
