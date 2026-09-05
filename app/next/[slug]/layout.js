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

/* The scroll-reveal arm. Inline and synchronous ON PURPOSE: it runs while the
   parser is still working, so `reveal-armed` is on <html> before the page below
   it paints. Setting the class from React instead would mean one frame of fully
   visible content followed by a snap to hidden, which is a flash on every load.

   It is also the ONLY thing that turns the hidden state on, which is what makes
   the animation unable to swallow the page: no JavaScript, an old browser, a
   thrown error, or a reader who asked for reduced motion, and the class never
   lands, so next.css's reveal rules never match and the family gets a plain
   document. The try/catch is there so that even a hostile matchMedia cannot
   take the page down with it. Motion itself lives in Reveal.js + next.css. */
const ARM_REVEAL = `try{if(window.matchMedia&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&'IntersectionObserver' in window){document.documentElement.classList.add('reveal-armed')}}catch(e){}`;

export default function NextLayout({ children }) {
  return (
    <PortalShell iconNames="">
      <script dangerouslySetInnerHTML={{ __html: ARM_REVEAL }} />
      {children}
    </PortalShell>
  );
}
