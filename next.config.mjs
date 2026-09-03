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
  // The old public cold-lead form lived at /parents (plural). The new family
  // portal is /parent (singular). Parents still have /parents bookmarked, so
  // forward it to the new portal. Temporary (307) on purpose — not browser-
  // cached, so it's reversible if /parents is ever needed as a public funnel.
  // Belt-and-braces noindex for the per-lead pages. The route already sets
  // `robots: { index: false, follow: false, nocache: true }` in its metadata, but
  // that only helps a crawler that parses the head. A /next/<slug> page carries a
  // minor's first name, a parent's contact details and that family's quoted
  // prices, so the header says the same thing at the transport layer, on every
  // response, including ones no parser ever reaches.
  async headers() {
    return [
      {
        source: '/next/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet, noimageindex' },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: '/parents', destination: '/parent', permanent: false },
      { source: '/parents/:path*', destination: '/parent', permanent: false },
    ];
  },
};

export default nextConfig;
