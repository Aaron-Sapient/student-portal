import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import PortalShell from '@/components/portal/PortalShell';
import { getGoogleSheetsClient } from '@/lib/google';
import { resolveIdentity, sessionEmail } from '@/lib/identity';
import ParentDataProvider from './ParentDataContext';
import ParentTabBar from './ParentTabBar';
import ChildSwitcher from './ChildSwitcher';
import AccountBubble from '@/components/portal/AccountBubble';

export const metadata = {
  title: 'Family Portal · Admissions.Partners',
  description: "Your student's progress, files, and check-ins in one place.",
};

export default async function ParentLayout({ children }) {
  // Authoritative server-side role gate: the email must sit in the Master
  // Sheet's parent columns (K/L). Students and unknown emails never see parent
  // UI — and every /api/parent/* route re-validates independently.
  const { userId, sessionClaims } = await auth();
  if (!userId) redirect('/sign-in');

  const email = sessionEmail(sessionClaims);
  const identity = await resolveIdentity(getGoogleSheetsClient(email), email);
  if (identity.role !== 'parent' || !identity.children.length) {
    // → /account, NOT /dashboard. The (portal) layout bounces a Clerk
    // `role: 'parent'` CLAIM to /parent/home, while this gate bounces on the
    // authoritative ROSTER lookup — so a user the claim calls a parent and the
    // roster does not (child's Class cell went NC, K/L edited, guardians mirror
    // stale under READ_SUPABASE_ROSTER=on, which treats a clean miss as
    // authoritative) ping-ponged between the two forever, rendering no page at
    // all. /account is outside both gates and tells them what's wrong.
    redirect('/account');
  }

  // Only serializable, non-sensitive child fields cross to the client.
  const kids = identity.children.map(({ name, grade, sheetId }) => ({
    name,
    grade,
    sheetId,
  }));

  return (
    <PortalShell iconNames="event,folder_open,home,school">
      <ParentDataProvider kids={kids}>
        <ParentTabBar />
        <AccountBubble />
        <main className="relative z-10 mx-auto w-full max-w-2xl px-5 pb-32 pt-20 sm:px-7 md:pt-10">
          <ChildSwitcher />
          {children}
        </main>
      </ParentDataProvider>
    </PortalShell>
  );
}
