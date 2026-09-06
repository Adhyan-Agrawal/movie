/**
 * Provider embed hosts allowed to be framed (Spec Sections 9 & 15). This MUST
 * stay in lockstep with `VIDSRC_PROVIDER_CONFIG.allowedDomains` in
 * `src/lib/providers/config.ts` — that file is the single source of truth for
 * provider domains, but next.config runs before the TS module graph is built,
 * so the host list is mirrored here. If the provider allowlist changes, update
 * both. `buildVidsrcUrl`/`assertSafeUrl` independently enforce the same
 * allowlist server-side, so a drift here can never produce an unsafe URL — it
 * would only over- or under-restrict framing.
 */
const PROVIDER_FRAME_HOSTS = ['https://vsembed.su', 'https://*.vsembed.su'];

/**
 * Content-Security-Policy (Spec Sections 9 & 15). Delivers the mandated
 * `frame-src` provider allowlist, `frame-ancestors 'none'` (no one may frame
 * Lumora — matches X-Frame-Options: DENY), and `object-src 'none'`.
 *
 * HONEST LIMITATION: `script-src` includes `'unsafe-inline'` because Next.js
 * injects inline bootstrap/hydration scripts and this app does not yet run a
 * nonce-issuing middleware. That is weaker than the spec's ideal "strict CSP."
 * Tightening to nonce-based `script-src` (removing `'unsafe-inline'`) is a
 * follow-up that belongs in middleware, where a per-request nonce can be minted
 * and threaded into Next's script tags. The framing controls below are the part
 * the spec calls out for the provider embed and are fully enforced today.
 */
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
  "script-src 'self' 'unsafe-inline'",
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
