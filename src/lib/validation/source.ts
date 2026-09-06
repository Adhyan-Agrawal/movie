import { z } from 'zod';

/**
 * Media source validation (Sections 6, 9, 15).
 *
 * A media source points the player at authorized content. Because operators can
 * paste arbitrary URLs (import flows, admin forms), URL handling here is part of
 * the SSRF threat model (Section 15): we require https, block private/loopback
 * hosts, and enforce a per-provider domain allowlist via {@link isAllowedHost}.
 */

/** Storage kinds — kept in sync with the `media_source_kind` DB enum (0003). */
export const MEDIA_SOURCE_KINDS = [
  'mp4',
  'hls',
  'dash',
  'youtube',
  'vimeo',
  'dailymotion',
  'vsembed',
  'iframe',
  'embed',
  'custom',
] as const;
export type MediaSourceKind = (typeof MEDIA_SOURCE_KINDS)[number];

export const SOURCE_QUALITIES = [
  'auto',
  '240p',
  '360p',
  '480p',
  '720p',
  '1080p',
  '1440p',
  '2160p',
] as const;

// ---------------------------------------------------------------------------
// SSRF-safe host validation
// ---------------------------------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed => treat as unsafe
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/** True for hosts that must never be reachable from a server-side fetch. */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host.length === 0) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return true;
  }

  // IPv6
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
    const trailing = host.split(':').pop();
    if (trailing && trailing.includes('.')) return isPrivateIPv4(trailing); // ::ffff:127.0.0.1
    return false;
  }

  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIPv4(host);
  return false;
}

/**
 * SSRF-safe host allowlist check (Section 15).
 *
 * Returns true only when `rawUrl` is a well-formed https URL, carries no
 * embedded credentials, does not target a private/loopback/link-local host, and
 * whose hostname exactly matches or is a subdomain of one of `allowedDomains`.
 * An empty allowlist denies everything.
 */
export function isAllowedHost(rawUrl: string, allowedDomains: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.username.length > 0 || url.password.length > 0) return false;

  const host = url.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(host)) return false;

  return allowedDomains.some((entry) => {
    const domain = entry.trim().toLowerCase().replace(/^\.+/, '');
    if (domain.length === 0) return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https:\/\//i.test(u), 'Source URL must use https');

/** Region-scoping policy stored alongside a source (jsonb in the DB). */
export const geoPolicySchema = z.object({
  mode: z.enum(['allow', 'block']).default('allow'),
  regions: z
    .array(z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code'))
    .default([]),
});
export type GeoPolicy = z.infer<typeof geoPolicySchema>;

export const mediaSourceInputSchema = z
  .object({
    kind: z.enum(MEDIA_SOURCE_KINDS),
    url: httpsUrl.optional(),
    /** Provider-relative reference/id used when the URL is derived server-side. */
    reference: z.string().min(1).max(300).optional(),
    label: z.string().max(120).default(''),
    language: z.string().min(2).max(10).default('en'),
    quality: z.enum(SOURCE_QUALITIES).default('auto'),
    priority: z.number().int().min(0).max(1000).default(100),
    isDefault: z.boolean().default(false),
    enabled: z.boolean().default(true),
    consentRequired: z.boolean().default(false),
    geoPolicy: geoPolicySchema.default({ mode: 'allow', regions: [] }),
  })
  .refine((source) => source.url !== undefined || source.reference !== undefined, {
    message: 'A media source needs either a direct url or a provider reference',
    path: ['url'],
  });

export type MediaSourceInput = z.infer<typeof mediaSourceInputSchema>;
