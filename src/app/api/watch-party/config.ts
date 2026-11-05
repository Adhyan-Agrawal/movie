import 'server-only';

interface WatchPartyServerConfig {
  secret: string;
  websocketUrl: string;
  canonicalAppOrigin: string;
}

function localHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function validatedOrigin(value: string | undefined, name: string, allowLocal: boolean): string {
  if (!value || value !== value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${name} is not configured.`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} is invalid.`); }
  const local = allowLocal && url.protocol === 'http:' && localHostname(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) throw new Error(`${name} must be an HTTPS origin.`);
  return url.origin;
}

export function watchPartyServerConfig(environment: NodeJS.ProcessEnv = process.env): WatchPartyServerConfig {
  const secret = environment.WATCH_PARTY_SECRET;
  if (!secret || secret.length < 32 || /[\r\n\0]/.test(secret)) {
    throw new Error('WATCH_PARTY_SECRET must contain at least 32 characters and no line breaks.');
  }
  const workerOrigin = validatedOrigin(environment.WATCH_PARTY_WORKER_URL, 'WATCH_PARTY_WORKER_URL',
    environment.NODE_ENV !== 'production');
  const canonicalAppOrigin = validatedOrigin(environment.NEXT_PUBLIC_APP_URL, 'NEXT_PUBLIC_APP_URL',
    environment.NODE_ENV !== 'production');
  const websocket = new URL('/v1/ws', workerOrigin);
  websocket.protocol = websocket.protocol === 'https:' ? 'wss:' : 'ws:';
  return { secret, websocketUrl: websocket.href, canonicalAppOrigin };
}

/** Only this validated boolean is forwarded during SSR, never the service configuration. */
export function isWatchPartyConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
  try {
    watchPartyServerConfig(environment);
    return true;
  } catch {
    return false;
  }
}
