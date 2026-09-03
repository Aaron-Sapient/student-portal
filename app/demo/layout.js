import PortalShell from '@/components/portal/PortalShell';
import './demo.css';

export const metadata = {
  title: 'Family Portal · Admissions.Partners',
  description: 'A sample family portal, shown during proposal meetings.',
  // Public by design (Ryan narrates it in proposal meetings), but it is a fictional
  // student and must never surface in search or be mistaken for a real family's page.
  robots: { index: false, follow: false, nocache: true },
};

/* The demo shell is the real PortalShell — same tokens, same fonts, same warm
   backdrop — minus every piece of chrome that exists to be OPERATED: no tab
   dock, no account bubble, no child switcher, no auth gate. Nobody touches this
   page; Ryan narrates it. The dock in particular is the single worst thing on
   the portal at desktop width (a floating phone pill parked over an empty
   third), so its absence is the point, not an omission.

   `iconNames` is empty because the Material Symbols subset exists for the dock
   alone. In-page glyphs are lucide, exactly as on every other portal surface. */
export default function DemoLayout({ children }) {
  return <PortalShell iconNames="">{children}</PortalShell>;
}
