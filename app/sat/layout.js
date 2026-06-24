import PortalShell from '@/components/portal/PortalShell';

// Public SAT practice surface (no auth — see proxy.js isPublicRoute). Reuses the
// shared PortalShell chrome (the .portal-root token scope, Fraunces/Hanken fonts,
// dark mode, atmospheric backdrop) WITHOUT the (portal) layout's Clerk gate or
// bottom tab dock — so the claymorphic look matches the rest of the site exactly.

export const metadata = {
  title: 'SAT Practice · Admissions.Partners',
  description: 'SAT vocab and grammar practice.',
};

export default function SatLayout({ children }) {
  return (
    <PortalShell iconNames="school">
      <main className="relative z-10 mx-auto w-full max-w-2xl px-5 pb-16 pt-10 sm:px-7">
        {children}
      </main>
    </PortalShell>
  );
}
