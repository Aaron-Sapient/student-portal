import { Fraunces, Hanken_Grotesk } from 'next/font/google';
import PortalTabBar from './PortalTabBar';
import PortalDataProvider from './PortalDataContext';

// Display: characterful optical serif. Body/UI: clean, friendly grotesque.
const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  display: 'swap',
});

const hanken = Hanken_Grotesk({
  subsets: ['latin'],
  variable: '--font-hanken',
  display: 'swap',
});

export const metadata = {
  title: 'Your Portal · Admissions.Partners',
  description: 'Check-ins, meetings, and deadlines in one place.',
};

export default function PortalLayout({ children }) {
  return (
    <div
      className={`${fraunces.variable} ${hanken.variable} relative min-h-screen bg-cream font-body text-ink antialiased`}
    >
      {/* Atmospheric backdrop: warm radial wash + faint grain, fixed so it
          never scrolls or shifts layout. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            'radial-gradient(120% 80% at 100% 0%, rgba(198,97,63,0.10), transparent 55%), radial-gradient(90% 70% at 0% 100%, rgba(94,107,79,0.07), transparent 50%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.5] mix-blend-multiply"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E\")",
        }}
      />

      <PortalDataProvider>
        {/* Desktop top nav lives inside the tab bar component; on mobile it
            renders the thumb-reachable bottom bar instead. */}
        <PortalTabBar />

        {/* Content column. Bottom padding clears the mobile tab bar. */}
        <main className="relative z-10 mx-auto w-full max-w-2xl px-5 pb-28 pt-6 sm:px-7 md:pb-16 md:pt-10">
          {children}
        </main>
      </PortalDataProvider>
    </div>
  );
}
