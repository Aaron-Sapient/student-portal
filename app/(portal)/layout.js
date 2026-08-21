import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import PortalShell from '@/components/portal/PortalShell';
import PortalTabBar from './PortalTabBar';
import AccountBubble from '@/components/portal/AccountBubble';
import PortalDataProvider from './PortalDataContext';

export const metadata = {
  title: 'Your Portal · Admissions.Partners',
  description: 'Check-ins, meetings, and your files in one place.',
};

export default async function PortalLayout({ children }) {
  // Claim-only role check (no Sheets call — zero added latency for students,
  // who carry no role claim). Parents get their own portal; the parent layout
  // does the authoritative sheet-based check in the other direction, and every
  // student API independently 404s non-student emails.
  const { sessionClaims } = await auth();
  if (sessionClaims?.role === 'parent') redirect('/parent/home');

  return (
    <PortalShell iconNames="calendar_month,fact_check,folder_open,groups,home,school">
      <PortalDataProvider>
        {/* Thumb-reachable floating dock, bottom on every breakpoint. */}
        <PortalTabBar />

        {/* "Which account am I in?" — see AccountBubble. Mounted in the LAYOUT, not
            in a page, so it still renders for a user whose roster lookup fails and
            every page below shows an error (verified: hasCheckinDue/
            hasBookingAvailable both guard `if (!data) return false`). */}
        <AccountBubble />

        {/* Content column. Bottom padding clears the floating tab dock. */}
        <main className="relative z-10 mx-auto w-full max-w-2xl px-5 pb-32 pt-20 sm:px-7 md:pt-10">
          {children}
        </main>
      </PortalDataProvider>
    </PortalShell>
  );
}
