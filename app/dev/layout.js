import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { ADMIN_EMAILS } from '@/lib/developerAuth';
import PortalShell from '@/components/portal/PortalShell';
import DevDataProvider from '@/app/developer/(panel)/DevDataContext';

export const metadata = {
  title: 'Scoring · Admissions.Partners',
  description: 'Holistic scoring admin.',
};

// The simplified admin surface: just the Scoring tab, no nav rail/dock.
// Admits Ryan as well as the developer (the full /developer portal stays
// developer-only); the scoring API routes gate on the same list.
export default async function DevLayout({ children }) {
  const { sessionClaims } = await auth();
  if (!ADMIN_EMAILS.includes(sessionClaims?.email)) redirect('/dashboard');

  return (
    <PortalShell className="dev-root" iconNames="tune">
      <DevDataProvider>
        <main className="relative z-10 mx-auto w-full max-w-[1500px] px-5 pb-16 pt-8 sm:px-8 md:pt-10">
          {children}
        </main>
      </DevDataProvider>
    </PortalShell>
  );
}
