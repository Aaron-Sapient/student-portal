// The second host the app answers on. Per-lead pages are served from its ROOT
// (next.admissions.partners/<slug>) while the portal keeps them at /next/<slug>;
// one deployment, one codebase, two front doors.
//
// Declared once and imported by proxy.js, because the middleware has to make the
// SAME host judgement to decide what is public, and two copies of a hostname is
// how one of them ends up stale. Anything that depends on this string being
// right will fail loudly (a 404, a sign-in wall) rather than quietly.
//
// MOVED 2026-09-09 from book.ryanchoice.com to next.admissions.partners. The old
// host is RETIRED, not deleted: it stays attached to this project and every path
// on it 308s to the same path here, because links already sent to families
// (Conor's, 2026-09-05) have to keep resolving forever.
export const BOOK_HOST = 'next.admissions.partners';
export const RETIRED_BOOK_HOST = 'book.ryanchoice.com';

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
  // The lead host serves the per-lead pages at the ROOT, so a family gets
  // next.admissions.partners/conor rather than a portal URL with /next/ in
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
      // THE RETIRED LEAD HOST. Every page on book.ryanchoice.com moves to the
      // same path on next.admissions.partners, permanently (308, so the method
      // and the browser cache both behave). It is FIRST in this list because a
      // redirect list is ordered and the first match wins: a family who was sent
      // a link on the old host should leave it in one hop, whatever the path.
      // Permanent is right here and temporary is right for /parents below,
      // because this host is never coming back and /parents might.
      //
      // `/api/` IS CARVED OUT, and the reason is a tab somebody already has
      // open. A document navigation follows a cross-origin 308 and lands on the
      // new host, where its own fetches are same-origin again. A fetch already
      // running inside an OLD page does not: the browser follows the redirect,
      // the request becomes cross-origin, and CORS (which this app sends no
      // headers for) drops the response. So a family sitting on Conor's page
      // when this ships would see the calendar fail to load and a booking fail
      // to confirm. The API is host-agnostic and already public on both hosts
      // (proxy.js), so leaving it answering here costs nothing and keeps an open
      // tab working until it is reloaded onto the new address.
      {
        source: '/:path((?!api/).*)',
        has: [{ type: 'host', value: RETIRED_BOOK_HOST }],
        destination: 'https://next.admissions.partners/:path',
        permanent: true,
      },
      { source: '/parents', destination: '/parent', permanent: false },
      { source: '/parents/:path*', destination: '/parent', permanent: false },
      // The bare root of the lead host. It is not a landing page and never
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
  // Headers match on the REQUEST path, before the rewrite above, so the lead
  // host needs its own entry: on that host the path is `/conor`, not
  // `/next/conor`, and the /next/:path* rule would never fire. The host
  // condition is what keeps this from stamping noindex on the whole portal.
  // The retired host needs no entry of its own: it serves nothing but 308s now.
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
