import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, currentUser } from '@clerk/nextjs/server';
import { ArrowLeft, CircleAlert, GraduationCap, Mail, Users } from 'lucide-react';
import { getGoogleSheetsClient } from '@/lib/google';
import { resolveIdentity, sessionEmail, normEmail } from '@/lib/identity';
import SignOutButton from './SignOutButton';

export const dynamic = 'force-dynamic';

const SUPPORT = 'support@admissions.partners';

// Why this page exists (2026-08-21): a student signed in with her school Google
// account instead of her personal one. Every portal route resolves a student by
// matching the session email against the Master Sheet col J, so all of them 404'd
// "Student not found" — and the app had NO sign-out control anywhere, so the
// advice "sign in with your other account" was impossible for her to act on.
//
// The page's north star is one question: WHICH ACCOUNT AM I IN? The email is the
// hero for that reason, not decoration — it is the value the incident turned on.
//
// Also the redirect target for the parent layout's roster gate, which used to
// point at /dashboard and could ping-pong forever against the (portal) layout's
// claim gate. Nothing here redirects, by design: this is the floor of the app.
export default async function AccountPage() {
  const { userId, sessionClaims } = await auth();
  if (!userId) redirect('/sign-in');

  // THE authoritative address: sessionEmail() is exactly what every API matches
  // the roster on. Deliberately NOT the client's useUser() — `email` is a CUSTOM
  // session claim (like `role`), so a stale/misconfigured claim would let the
  // page show a reassuring address while the APIs 404 on a different one. If the
  // two disagree we surface it rather than pick a winner.
  const email = normEmail(sessionEmail(sessionClaims));
  const user = await currentUser().catch(() => null);
  const clerkEmail = normEmail(user?.primaryEmailAddress?.emailAddress);
  const mismatch = !!(email && clerkEmail && email !== clerkEmail);
  const clerkName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();

  // The roster lookup is the diagnosis, but it must never take the page down: if
  // Sheets/Supabase is unreachable we still owe the user their email and a
  // working sign-out, which is the entire point of this page.
  let identity = null;
  let lookupFailed = false;
  try {
    identity = await resolveIdentity(getGoogleSheetsClient(email), email);
  } catch {
    lookupFailed = true;
  }

  const role = identity?.role ?? null;
  const childNames =
    role === 'parent' ? identity.children.map((c) => c.name).filter(Boolean) : [];
  const rosterName = role === 'student' ? String(identity.studentRow?.[0] ?? '').trim() : '';
  const klass = role === 'student' ? String(identity.studentRow?.[1] ?? '').trim() : '';

  // A 'parent' with zero usable children reaches this page via the parent
  // layout's gate and is, functionally, unmatched — treat it as such.
  const unmatched = !lookupFailed && (role === null || (role === 'parent' && !childNames.length));
  const matched = !lookupFailed && !unmatched;

  const display = rosterName || clerkName || email;
  const initial = (display.match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();
  const backHref = role === 'parent' ? '/parent/home' : '/dashboard';
  const mailto = `mailto:${SUPPORT}?subject=${encodeURIComponent(
    'Portal sign-in — account not recognised'
  )}&body=${encodeURIComponent(
    `Hi — I'm signed in to the portal as ${email} and it says my account isn't connected to a student record.\n\nMy name: \n`
  )}`;

  return (
    <div className="space-y-8">
      <Link
        href={backHref}
        className="-ml-1 inline-flex min-h-11 items-center gap-1.5 rounded-xl pr-2 text-sm font-semibold text-ink-soft transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        Back to the portal
      </Link>

      {/* The email carries the largest, darkest type on the page because it is
          the answer to the only question this page exists to ask. */}
      <header className="portal-rise flex items-start gap-4">
        <div
          aria-hidden
          className="neu-raised grid h-14 w-14 shrink-0 place-items-center rounded-full font-display text-xl font-semibold text-ink-soft"
        >
          {initial}
        </div>
        <div className="min-w-0 pt-0.5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
            Signed in as
          </p>
          <p className="mt-1 break-all font-display text-[1.4rem] font-semibold leading-tight tracking-tight text-ink">
            {email || 'unknown address'}
          </p>
          {display !== email && <p className="mt-1 text-sm text-ink-soft">{display}</p>}
          {mismatch && (
            <p className="mt-2 text-sm text-ink-soft">
              Your Google profile says{' '}
              <span className="font-semibold text-ink">{clerkEmail}</span>. The portal
              matches on the address above — if they disagree, tell {SUPPORT}.
            </p>
          )}
        </div>
      </header>

      <section className="portal-rise" style={{ animationDelay: '50ms' }}>
        {matched && role === 'student' && (
          <div className="flex items-start gap-3 rounded-2xl border border-sand/70 bg-clay-50/60 p-4">
            <GraduationCap className="mt-0.5 h-5 w-5 shrink-0 text-moss" strokeWidth={2} aria-hidden />
            <p className="text-sm text-ink">
              Connected to your student record
              {rosterName ? <> — <span className="font-semibold">{rosterName}</span></> : null}
              {klass ? <span className="text-ink-soft"> ({klass})</span> : null}.
            </p>
          </div>
        )}

        {matched && role === 'parent' && (
          <div className="flex items-start gap-3 rounded-2xl border border-sand/70 bg-clay-50/60 p-4">
            <Users className="mt-0.5 h-5 w-5 shrink-0 text-moss" strokeWidth={2} aria-hidden />
            <p className="text-sm text-ink">
              Parent account for <span className="font-semibold">{childNames.join(', ')}</span>.
            </p>
          </div>
        )}

        {unmatched && (
          <div className="rounded-2xl border border-terracotta/30 bg-clay-50 p-5">
            <div className="flex items-start gap-3">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-terracotta" strokeWidth={2} aria-hidden />
              <div className="min-w-0">
                <p className="font-display text-base font-semibold text-ink">
                  We couldn’t match this address to a student record
                </p>
                {/* Deliberately "couldn't match", not "isn't connected": under
                    READ_SUPABASE_ROSTER=on a clean miss against a stale mirror is
                    treated as authoritative with no Sheets fallback, so a real
                    student can land here. Telling them their account doesn't
                    exist would be a confident wrong answer. */}
                <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
                  That’s what’s behind the “Student not found” messages. Nothing has been
                  deleted. The usual cause is being signed in with a different Google
                  account than the one we have on file — a school address instead of a
                  personal one, for example.
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <SignOutButton label="Sign out and switch account" tone="loud" />
              {/* Clerk 7 exposes no way to pass Google's `prompt=select_account`
                  from app code (SignOutOptions is {sessionId, redirectUrl} only),
                  so if the device holds ONE Google session, Google re-selects it
                  silently and the student lands right back here. Say so, and give
                  two routes that work regardless. */}
              <p className="text-xs leading-relaxed text-ink-faint">
                You’ll be asked which Google account to use. If your account still isn’t
                recognised afterwards, it’s the address that needs fixing, not the sign-in —
                use the link below.
              </p>
              <a
                href={mailto}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl px-1 text-sm font-semibold text-terracotta-deep underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
              >
                <Mail className="h-4 w-4" strokeWidth={2} aria-hidden />
                Or email us — this is the right address for me
              </a>
              {/* Some students only HAVE the school account on their device. For
                  them the fix is us adding it to the roster, not them switching. */}
            </div>
          </div>
        )}

        {lookupFailed && (
          <div className="flex items-start gap-3 rounded-2xl border border-sand/70 bg-clay-50/60 p-4">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-ochre" strokeWidth={2} aria-hidden />
            <p className="text-sm text-ink-soft">
              We couldn’t reach your student record just now, so we can’t confirm the
              connection. Your sign-in itself is fine — try the portal again in a minute.
            </p>
          </div>
        )}
      </section>

      {/* The always-present exit. Suppressed only when the unmatched card above
          already renders a louder copy — two sign-out buttons on one short page
          read as two different actions. */}
      {!unmatched && (
        <section className="portal-rise" style={{ animationDelay: '100ms' }}>
          <SignOutButton />
          <p className="mt-3 text-center text-xs leading-relaxed text-ink-faint">
            You’ll be asked which Google account to use when you sign back in.
          </p>
        </section>
      )}
    </div>
  );
}
