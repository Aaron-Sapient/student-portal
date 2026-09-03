import PortalShell from '@/components/portal/PortalShell';
import './next.css';

/* The same shell the /demo board runs on: the portal's token scope, its two
   fonts, its warm backdrop. No dock, no account bubble, no auth gate. Nobody
   signs in here and there is nothing on the page to operate except the
   calendar, so every piece of chrome that exists to be operated is absent.

   iconNames is empty because the Material Symbols subset exists for the tab
   dock alone, and Google 400s an empty icon_names request, so PortalShell skips
   the stylesheet entirely. */

export const metadata = {
  title: 'Admissions.Partners',
  description: 'Booking a second conversation.',
  /* A private page reached by an unguessable address. Keep it out of the index
     the same way /write and /proposal are kept out. */
  robots: { index: false, follow: false },
};

export default function NextLayout({ children }) {
  return <PortalShell iconNames="">{children}</PortalShell>;
}
