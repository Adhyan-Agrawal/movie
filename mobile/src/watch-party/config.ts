import { WEB_URL, webRuntimeConfig } from '../lib/runtime-config';

const webUrl = new URL(WEB_URL);
export const WATCH_PARTY_CLOUDFLARE_BASE_URL = webUrl.origin;

// Non-secret release gate. Opt in only after the configured service is verified.
export const WATCH_PARTY_SERVICE_AVAILABLE = webRuntimeConfig.available
  && process.env.EXPO_PUBLIC_WATCH_PARTY_AVAILABLE === 'true'
  && (webUrl.protocol === 'https:' || (webUrl.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(webUrl.hostname)));
export const WATCH_PARTY_UNAVAILABLE_MESSAGE = 'Watch Party is unavailable on the current service. You can still watch this title on your own.';
