import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { DEVELOPER_EMAIL } from '@/lib/developerAuth';
import PortalShell from '@/components/portal/PortalShell';
import DevDataProvider from './DevDataContext';
import DevNav from './DevNav';

export const metadata = {
  title: 'Dev Portal · Admissions.Partners',
  description: 'Admin tools.',
};

export default async function DevPanelLayout({ children }) {
  // Same gate as the old dashboard page; every /api/developer/* route is also
  // independently guarded by requireDeveloper().
  const { sessionClaims } = await auth();
  if (sessionClaims?.email !== DEVELOPER_EMAIL) redirect('/dashboard');

  return (
    <PortalShell
      className="dev-root"
      iconNames="calendar_month,description,edit_document,event_busy,fact_check,stylus_note,tune"
    >
      <DevDataProvider>
        <DevNav />
        {/* Wide column (tables) — clears the left rail on desktop, the bottom
            dock on phones. */}
        <main className="relative z-10 mx-auto w-full max-w-[1500px] px-5 pb-32 pt-8 sm:px-8 md:pb-12 md:pl-[8.5rem] md:pt-10">
          {children}
        </main>
      </DevDataProvider>
    </PortalShell>
  );
}
