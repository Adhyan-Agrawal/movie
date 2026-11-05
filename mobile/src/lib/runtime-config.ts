export const DEFAULT_WEB_URL = 'https://hulkofyt.eu.org';

const DISABLED_SUPABASE_URL = 'https://unconfigured.invalid';
const DISABLED_SUPABASE_ANON_KEY = 'unconfigured-public-anon-key';

function value(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  return trimmed ? trimmed : undefined;
}

function safeBaseUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

export interface WebRuntimeConfig {
  url: string;
  available: boolean;
  source: 'default' | 'environment' | 'invalid';
}

/** Invalid explicit URLs disable web calls; an absent value keeps the shipped public default. */
export function resolveWebRuntimeConfig(input: string | undefined): WebRuntimeConfig {
  const configured = value(input);
  if (!configured) return { url: DEFAULT_WEB_URL, available: true, source: 'default' };
  const url = safeBaseUrl(configured);
  return url
    ? { url, available: true, source: 'environment' }
    : { url: DEFAULT_WEB_URL, available: false, source: 'invalid' };
}

export interface SupabaseRuntimeConfig {
  url: string;
  anonKey: string;
  configured: boolean;
}

/** Always returns constructor-safe values while separately reporting real availability. */
export function resolveSupabaseRuntimeConfig(urlInput: string | undefined, keyInput: string | undefined): SupabaseRuntimeConfig {
  const rawUrl = value(urlInput);
  const anonKey = value(keyInput);
  const url = rawUrl ? safeBaseUrl(rawUrl) : null;
  const validUrl = !!url && (url.startsWith('https://') || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(url));
  const validKey = !!anonKey && !/^<.*>$/.test(anonKey) && !/\s/.test(anonKey);
  return validUrl && validKey
    ? { url, anonKey, configured: true }
    : { url: DISABLED_SUPABASE_URL, anonKey: DISABLED_SUPABASE_ANON_KEY, configured: false };
}

export const webRuntimeConfig = resolveWebRuntimeConfig(process.env.EXPO_PUBLIC_WEB_URL);
export const WEB_URL = webRuntimeConfig.url;
