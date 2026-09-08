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
  'https://vidcore.org',
  'https://*.vidcore.org',
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
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.highperformanceformat.com"
  : "script-src 'self' 'unsafe-inline' https://www.highperformanceformat.com";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // 'self' covers the /api/ad-frame banner documents (Spec Section 11); the
  // rest are the provider embeds, Adsterra's creative host, and YouTube for
  // trailers.
  `frame-src 'self' ${PROVIDER_FRAME_HOSTS.join(' ')} https://www.highperformanceformat.com https://www.youtube.com https://www.youtube-nocookie.com`,
  "img-src 'self' https://image.tmdb.org https://i.ytimg.com data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  SCRIPT_SRC,
  // Native player (Spec Sections 7, 9): signed Supabase-storage URLs and
  // admin-configured remote streams. https: is required because remote
  // licensed CDN hosts are not known ahead of time; hls.js fetches segments
  // over XHR, so connect-src must allow them too.
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.themoviedb.org https:",
  "media-src 'self' blob: https:",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    // Serve artwork DIRECTLY from its origin (image.tmdb.org / i.ytimg.com)
    // instead of Vercel's image optimizer. TMDB posters are already optimized
    // at the source and re-encoding them on Vercel is a billable operation the
    // operator explicitly wants to avoid — a plain <img> with the original URL
    // is what the browser gets.
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: 'image.tmdb.org' },
      { protocol: 'https', hostname: 'i.ytimg.com' },
    ],
  },
  async headers() {
    return [
      {
        // Everything EXCEPT the ad-frame document, which must be framable by
        // our own pages (it carries its own permissive CSP below).
        source: '/((?!api/ad-frame).*)',
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
