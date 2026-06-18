import { Fraunces, Hanken_Grotesk } from 'next/font/google';

// Shared chrome for every portal surface (student, parent, developer): the
// .portal-root token scope, fonts, subsetted Material Symbols link, and the
// fixed atmospheric backdrop. Each layout composes its own provider/tab bar/
// main column inside `children`.

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

export default function PortalShell({ iconNames, className = '', children }) {
  // Google Fonts 400s the css2 request unless icon_names is alphabetically
  // sorted, which silently kills the WHOLE subset (every glyph falls back to its
  // ligature text). Normalize here so callers can list icons in any order — and
  // a stray out-of-order name can never break the nav again.
  const sortedIconNames = (iconNames || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join(',');

  return (
    <div
      className={`portal-root ${className} ${fraunces.variable} ${hanken.variable} relative min-h-screen bg-cream font-body text-ink antialiased`}
      style={{
        // With viewport-fit=cover the page extends under the notch in
        // landscape; keep content out of it while the fixed backdrops
        // (inset-0, below) still paint edge to edge.
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      {/* Material Symbols (Rounded) for the tab bar only. Subsetted to the nav
          glyphs via icon_names so the payload is tiny; display=block avoids the
          ligature-text flash before the font loads. icon_names is normalized to
          alphabetical order above (Google 400s an unsorted list). */}
      <link
        rel="stylesheet"
        href={`https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-25..0&icon_names=${sortedIconNames}&display=block`}
      />
      {/* Atmospheric backdrop: warm radial wash + faint grain, fixed so it
          never scrolls or shifts layout. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            'radial-gradient(90% 70% at 0% 100%, rgba(94,107,79,0.07), transparent 50%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.5] mix-blend-multiply dark:opacity-[0.22] dark:mix-blend-soft-light"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E\")",
        }}
      />

      {children}
    </div>
  );
}
