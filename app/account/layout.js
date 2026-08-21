import PortalShell from '@/components/portal/PortalShell';

export const metadata = {
  title: 'Your account · Admissions.Partners',
  description: 'Check which account you are signed in as, and sign out.',
};

// Top-level route, NOT under (portal) or /parent, and deliberately so: both of
// those layouts make role decisions (the parent layout redirects non-parents to
// /dashboard), and the single user who most needs this page is the one whose
// role resolves to NULL. Nesting it under either would redirect the person it
// exists for. No dock either — this is a leaf you arrive at and leave.
export default function AccountLayout({ children }) {
  return (
    <PortalShell iconNames="arrow_back">
      <main className="relative z-10 mx-auto w-full max-w-lg px-5 pb-16 pt-10 sm:px-7">
        {children}
      </main>
    </PortalShell>
  );
}
