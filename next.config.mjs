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
  // A proposal is a named family's priced contract behind a capability url, so
  // it must not be stored by a shared browser cache or a proxy, and the copy a
  // family re-opens has to be re-fetched rather than replayed from disk (the
  // totals, the expiry and the enrolled state all move server-side).
  async headers() {
    return [
      {
        source: '/proposal/:path*',
        headers: [{ key: 'Cache-Control', value: 'private, no-store, max-age=0' }],
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
