import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { ADMIN_EMAILS } from '@/lib/developerAuth';
import PortalShell from '@/components/portal/PortalShell';
import DevDataProvider from '@/app/developer/(panel)/DevDataContext';
import DevNav from '@/app/developer/(panel)/DevNav';

export const metadata = {
  title: 'Scoring · Admissions.Partners',
  description: 'Holistic scoring admin.',
};

// The simplified admin surface: Scoring (params) + Students, same rail/dock
// chrome as /developer. Admits Ryan as well as the developer (the full
// /developer portal stays developer-only); the scoring API routes gate on the
// same ADMIN_EMAILS list.
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
        <DevNav tabs={DEV_TABS} />
        {/* Wide column (tables) — clears the left rail on desktop, the bottom
            dock on phones. Mirrors the (panel) layout. */}
        <main className="relative z-10 mx-auto w-full max-w-[1500px] px-5 pb-32 pt-8 sm:px-8 md:pb-12 md:pl-[8.5rem] md:pt-10">
          {children}
        </main>
      </DevDataProvider>
    </PortalShell>
  );
}
