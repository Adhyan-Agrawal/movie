/**
 * Provider embed hosts allowed to be framed (Spec Sections 9 & 15). This MUST
 * stay in lockstep with the provider configs in `src/lib/providers/config.ts`
 * (allowedDomains per provider). That file is the single source of truth, but
 * next.config runs before the TS module graph is built, so the host list is
 * mirrored here. If the provider allowlist changes, update both.
 * `buildVidsrcUrl`/`assertSafeUrl` independently enforce the same allowlist
 * server-side, so a drift here can never produce an unsafe URL — it would only
 * over- or under-restrict framing.
 */
const PROVIDER_FRAME_HOSTS = [
  'https://vidup.to',
  'https://*.vidup.to',
  'https://2embed.cc',
  'https://*.2embed.cc',
  'https://vsembed.su',
  'https://*.vsembed.su',
  'https://vidsrc.mov',
  'https://*.vidsrc.mov',
];

/**
 * Content-Security-Policy (Spec Sections 9 & 15). Delivers the mandated
 * `frame-src` provider allowlist, `frame-ancestors 'none'` (no one may frame
 * Lumora — matches X-Frame-Options: DENY), and `object-src 'none'`.
 *
 * HONEST LIMITATIONS:
 *  - `script-src` includes `'unsafe-inline'` because Next.js injects inline
 *    bootstrap/hydration scripts and this app does not yet run a nonce-issuing
 *    middleware. Tightening to nonce-based `script-src` is a follow-up that
 *    belongs in middleware.
 *  - DEVELOPMENT ONLY: `'unsafe-eval'` is added because React's dev-mode
 *    runtime (source maps, error formatting, refresh) uses eval; without it
 *    client components fail to hydrate. Production builds never include it.
 * The framing controls below are the part the spec calls out for the provider
 * embed and are fully enforced today.
 */
const isDev = process.env.NODE_ENV !== 'production';
const SCRIPT_SRC = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `frame-src ${PROVIDER_FRAME_HOSTS.join(' ')}`,
  "img-src 'self' https://image.tmdb.org data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  SCRIPT_SRC,
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.themoviedb.org",
  "media-src 'self' blob:",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'image.tmdb.org' },
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
        ],
      },
    ];
  },
};

export default nextConfig;
