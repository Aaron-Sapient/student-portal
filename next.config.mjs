/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  reactCompiler: true,
  // Allow dev servers reached over the tailnet via `tailscale serve` to make
  // cross-origin requests for dev assets/HMR. localhost is always allowed, so
  // plain local Mac dev is unaffected. `aarons-macbook-pro` is the Mac itself
  // (host on the Mac, test on the iPhone over Tailscale); `qnappy` is the NAS.
  allowedDevOrigins: ['aarons-macbook-pro.tail4ab0a5.ts.net', 'qnappy.tail4ab0a5.ts.net'],
};

export default nextConfig;
