// The second host the app answers on. Per-lead booking pages are served from
// its ROOT (book.ryanchoice.com/<slug>) while the portal keeps them at
// /next/<slug>; one deployment, one codebase, two front doors.
//
// Declared once and imported by proxy.js, because the middleware has to make the
// SAME host judgement to decide what is public, and two copies of a hostname is
// how one of them ends up stale. Anything that depends on this string being
// right will fail loudly (a 404, a sign-in wall) rather than quietly.
export const BOOK_HOST = 'book.ryanchoice.com';

/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  reactCompiler: true,
  devIndicators: false,
  // Allow dev servers reached over the tailnet via `tailscale serve` to make
  // cross-origin requests for dev assets/HMR. localhost is always allowed, so
  // plain local Mac dev is unaffected. `aarons-macbook-pro` is the Mac itself
  // (host on the Mac, test on the iPhone over Tailscale); `qnappy` is the NAS.
  allowedDevOrigins: ['aarons-macbook-pro.tail4ab0a5.ts.net', 'aarons-macbook-pro-1.tail4ab0a5.ts.net', 'qnappy.tail4ab0a5.ts.net'],
  // book.ryanchoice.com serves the per-lead pages at the ROOT, so a family gets
  // book.ryanchoice.com/conor-c44061 rather than a portal URL with /next/ in
  // it. Shared with the portal deployment on purpose: one codebase, one set of
  // routes, one place the booking logic lives.
  async rewrites() {
    return [
      {
        // Only a single path segment. `/:slug` will not match `/a/b`, so nothing
        // deeper on this host is silently rewritten into the lead namespace, and
        // /_next/*, /api/* and every other multi-segment path are untouched.
        source: '/:slug',
        has: [{ type: 'host', value: BOOK_HOST }],
        destination: '/next/:slug',
      },
    ];
  },
  // The old public cold-lead form lived at /parents (plural). The new family
  // portal is /parent (singular). Parents still have /parents bookmarked, so
  // forward it to the new portal. Temporary (307) on purpose — not browser-
  // cached, so it's reversible if /parents is ever needed as a public funnel.
  async redirects() {
    return [
      { source: '/parents', destination: '/parent', permanent: false },
      { source: '/parents/:path*', destination: '/parent', permanent: false },
      // The bare root of the booking host. It is not a landing page and never
      // will be: every real address on this host is a slug somebody was sent.
      // Sending it to the portal home rather than 404ing is the kinder answer
      // for the one person who will ever type it (a parent who deleted the rest
      // of the URL), and it leaks nothing: portal.admissions.partners/ is a
      // sign-in wall, not a page about this family.
      {
        source: '/',
        has: [{ type: 'host', value: BOOK_HOST }],
        destination: 'https://portal.admissions.partners/',
        permanent: false,
      },
    ];
  },
  // Belt-and-braces noindex for the per-lead pages. The route already sets
  // `robots: { index: false, follow: false, nocache: true }` in its metadata, but
  // that only helps a crawler that parses the head. A lead page carries a
  // minor's first name, a parent's contact details and that family's quoted
  // prices, so the header says the same thing at the transport layer, on every
  // response, including ones no parser ever reaches.
  //
  // Headers match on the REQUEST path, before the rewrite above, so the book
  // host needs its own entry: on that host the path is `/conor-c44061`, not
  // `/next/conor-c44061`, and the /next/:path* rule would never fire. The host
  // condition is what keeps this from stamping noindex on the whole portal.
  async headers() {
    const noindex = [
      { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet, noimageindex' },
    ];
    return [
      { source: '/next/:path*', headers: noindex },
      { source: '/:path*', has: [{ type: 'host', value: BOOK_HOST }], headers: noindex },
    ];
  },
};

export default nextConfig;
