import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import PortalShell from '@/components/portal/PortalShell';
import { getGoogleSheetsClient } from '@/lib/google';
import { resolveIdentity, sessionEmail } from '@/lib/identity';
import ParentDataProvider from './ParentDataContext';
import ParentTabBar from './ParentTabBar';
import ChildSwitcher from './ChildSwitcher';

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
    redirect('/dashboard');
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
        <main className="relative z-10 mx-auto w-full max-w-2xl px-5 pb-32 pt-8 sm:px-7 md:pt-10">
          <ChildSwitcher />
          {children}
        </main>
      </ParentDataProvider>
    </PortalShell>
  );
}
