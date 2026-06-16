import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { ADMIN_EMAILS } from '@/lib/developerAuth';
import PortalShell from '@/components/portal/PortalShell';
import DevDataProvider from '@/app/developer/(panel)/DevDataContext';
import TabDock from '@/components/portal/TabDock';

export const metadata = {
  title: 'Scoring · Admissions.Partners',
  description: 'Holistic scoring admin.',
};

// The simplified admin surface: Scoring (params) + Students + Packages. Admits
// Ryan as well as the developer (the full /developer portal stays
// developer-only); the scoring API routes gate on the same ADMIN_EMAILS list.
const DEV_TABS = [
  { href: '/dev/scoring', label: 'Scoring', sym: 'tune' },
  { href: '/dev/students', label: 'Students', sym: 'group' },
  { href: '/dev/packages', label: 'Packages', sym: 'sell' },
];

export default async function DevLayout({ children }) {
  const { sessionClaims } = await auth();
  if (!ADMIN_EMAILS.includes(sessionClaims?.email)) redirect('/dashboard');

  return (
    <PortalShell className="dev-root" iconNames="group,tune,sell">
      <DevDataProvider>
        {/* Only three tabs here, so this surface uses the student portal's
            horizontal glass dock (bottom on every breakpoint) rather than the
            /developer panel's tall left rail. */}
        <TabDock tabs={DEV_TABS} />
        {/* Wide column (tables). Bottom padding clears the floating dock on
            every breakpoint. */}
        <main className="relative z-10 mx-auto w-full max-w-[1500px] px-5 pb-32 pt-8 sm:px-8 md:pt-10">
          {children}
        </main>
      </DevDataProvider>
    </PortalShell>
  );
}
