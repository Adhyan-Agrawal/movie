/**
 * Vidsrc / VSEmbed provider adapter (Spec Section 9: "Vidsrc/VSEmbed API integration").
 *
 * This module builds and validates provider URLs SERVER-SIDE and returns only a
 * sanitized iframe URL to the client. It never scrapes the iframe, injects
 * scripts into it, or attempts to bypass provider restrictions. The pure
 * `buildVidsrcUrl(config, request)` function is the unit-testable core.
 *
 * SECURITY / CSP (configured elsewhere — see next.config.mjs headers, which are
 * owned by the platform config and must NOT be edited from this slice):
 *   - This iframe embed requires a Content-Security-Policy `frame-src`
 *     directive that allowlists the provider origin, sourced from
 *     `ProviderConfig.allowedDomains` (e.g. `frame-src https://vsembed.su`).
 *     Without it a strict CSP will block the embed.
 *   - `frame-ancestors`/`X-Frame-Options` on Lumora's responses govern who may
 *     frame Lumora (currently `X-Frame-Options: DENY`) — that is a separate
 *     concern from embedding a provider here and should stay restrictive.
 *   - Origin allowlisting for the constructed URL's host is enforced below by
 *     `assertHostAllowed`; a URL whose host is not allowlisted is rejected as a
 *     recoverable error rather than ever being returned to the client.
 */

import type {
  Capabilities,
  HealthResult,
  HealthStatus,
  PlaybackError,
  PlaybackRequest,
  PlaybackSource,
  PlaybackType,
  ProviderAdapter,
} from './types';
import { ProviderError } from './types';
import { VIDSRC_PROVIDER_CONFIG, type ProviderConfig } from './config';

/** IMDb ids are `tt` followed by 6–10 digits. */
const IMDB_RE = /^tt\d{6,10}$/;
/** TMDB ids are positive integers. */
const TMDB_RE = /^\d{1,12}$/;

export interface BuildOptions {
  /**
   * Use the documented shorthand season-episode route
   * (`tvSeriesPath/{id}-{season}-{episode}`) instead of the nested episode
   * route. Both are documented; the canonical nested route is the default.
   */
  shorthand?: boolean;
}

/**
 * Pure, server-side URL builder — the unit-testable core of the adapter.
 * Throws a recoverable {@link ProviderError} rather than ever returning an
 * unsafe or ambiguous URL.
 */
export function buildVidsrcUrl(
  config: ProviderConfig,
  request: PlaybackRequest,
  options: BuildOptions = {},
): string {
  const providerId = config.id;

  if (!config.enabled) {
    throw new ProviderError({
      code: 'provider-disabled',
      message: `${config.displayName} is disabled.`,
      recoverable: true,
      providerId,
    });
  }

  const id = resolveMediaId(request, providerId);
  const path = buildPath(config, request, id, Boolean(options.shorthand), providerId);
  const url = assertSafeUrl(config, path, providerId);
  return url.toString();
}

/** Choose and validate the provider id (IMDb preferred, then TMDB). */
function resolveMediaId(request: PlaybackRequest, providerId: string): string {
  const imdb = request.imdbId?.trim();
  const tmdb = request.tmdbId?.trim();

  if (imdb) {
    if (!IMDB_RE.test(imdb)) {
      throw invalidRequest('The IMDb identifier is malformed.', providerId);
    }
    return imdb;
  }
  if (tmdb) {
    if (!TMDB_RE.test(tmdb)) {
      throw invalidRequest('The TMDB identifier is malformed.', providerId);
    }
    return tmdb;
  }
  // No usable identifier — ambiguous/invalid; recover rather than guess.
  throw invalidRequest('No TMDB or IMDb identifier is available to resolve playback.', providerId);
}

/** Select the correct route template and fill it. */
function buildPath(
  config: ProviderConfig,
  request: PlaybackRequest,
  id: string,
  shorthand: boolean,
  providerId: string,
): string {
  if (request.type === 'movie') {
    return fillTemplate(config.moviePathTemplate, { id }, providerId);
  }

  const { season, episode } = request;
  if (season !== undefined && episode !== undefined) {
    const s = normalizeIndex(season, 'season', providerId);
    const e = normalizeIndex(episode, 'episode', providerId);
    const template = shorthand ? config.shorthandEpisodeTemplate : config.episodePathTemplate;
    return fillTemplate(template, { id, season: s, episode: e }, providerId);
  }
  if (season !== undefined || episode !== undefined) {
    throw invalidRequest(
      'Both season and episode are required to resolve a specific episode.',
      providerId,
    );
  }
  // Whole series — provider's built-in season/episode picker.
  return fillTemplate(config.tvSeriesPathTemplate, { id }, providerId);
}

/** Replace `{id}`/`{season}`/`{episode}` placeholders; reject anything else. */
function fillTemplate(
  template: string,
  vars: { id?: string; season?: string; episode?: string },
  providerId: string,
): string {
  const filled = template.replace(/\{(id|season|episode)\}/g, (_match, key: string) => {
    const value = vars[key as 'id' | 'season' | 'episode'];
    if (value === undefined) {
      throw new ProviderError({
        code: 'unsupported',
        message: `Provider template is missing a value for {${key}}.`,
        recoverable: false,
        providerId,
      });
    }
    return encodeURIComponent(value);
  });
  // Defense in depth: no unresolved placeholder may survive into a real URL.
  if (/\{[^}]+\}/.test(filled)) {
    throw new ProviderError({
      code: 'unsupported',
      message: 'Provider template contains an unresolved placeholder.',
      recoverable: false,
      providerId,
    });
  }
  return filled;
}

/** Validate a season/episode index is a non-negative integer. */
function normalizeIndex(value: number, field: 'season' | 'episode', providerId: string): string {
  if (!Number.isInteger(value) || value < 0) {
    throw invalidRequest(`The ${field} number is invalid.`, providerId);
  }
  return String(value);
}

/**
 * Resolve `path` against the provider base and enforce https + host allowlist.
 * Rejecting an out-of-allowlist host is a RECOVERABLE error and, crucially, we
 * never return an unsafe URL (Spec Section 9 & 15: origin allowlisting, SSRF /
 * open-redirect / iframe-abuse mitigation).
 */
function assertSafeUrl(config: ProviderConfig, path: string, providerId: string): URL {
  let url: URL;
  try {
    url = new URL(path, config.baseUrl);
  } catch {
    throw new ProviderError({
      code: 'unsupported',
      message: 'Could not construct a valid provider URL.',
      recoverable: false,
      providerId,
    });
  }

  if (url.protocol !== 'https:') {
    throw new ProviderError({
      code: 'host-not-allowed',
      message: 'Provider URL must use https.',
      recoverable: true,
      providerId,
    });
  }
  if (!isHostAllowed(url.hostname, config.allowedDomains)) {
    // Do not echo the rejected host — keep the error safe to log/display.
    throw new ProviderError({
      code: 'host-not-allowed',
      message: 'The resolved provider host is not in the configured allowlist.',
      recoverable: true,
      providerId,
    });
  }
  return url;
}

/** Exact host match or a dot-boundary subdomain of an allowed domain. */
function isHostAllowed(host: string, allowedDomains: string[]): boolean {
  const h = host.toLowerCase();
  return allowedDomains.some((domain) => {
    const d = domain.trim().toLowerCase();
    if (!d) return false;
    return h === d || h.endsWith(`.${d}`);
  });
}

function invalidRequest(message: string, providerId: string): ProviderError {
  return new ProviderError({ code: 'invalid-request', message, recoverable: true, providerId });
}

/** Capabilities the Vidsrc embed genuinely exposes (Spec Section 9). */
function vidsrcCapabilities(type: PlaybackType): Capabilities {
  return {
    fullscreen: true,
    qualitySelection: true, // provider renders its own Auto + resolution menu
    subtitles: true, // provider offers multi-language subtitles where available
    audioTracks: false, // not exposed via the embed API
    playbackRate: false, // not guaranteed by the embed API
    episodeSelection: type === 'tv', // built-in season/episode picker for TV
    providerResume: true, // provider keeps its own resume position
    telemetry: false, // embeds do NOT emit reliable heartbeats/completion
    skipMarkers: false, // not exposed by the embed API
  };
}

/** Map any thrown value to a safe, normalized PlaybackError (no URLs/tokens). */
function normalizeVidsrcError(error: unknown, providerId: string): PlaybackError {
  if (error instanceof ProviderError) {
    return error.toPlaybackError();
  }
  // Fetch aborts surface as an AbortError (DOMException in browsers, Error in Node).
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'timeout', message: 'The provider took too long to respond.', recoverable: true, providerId };
  }
  if (error instanceof TypeError) {
    // fetch() network failures throw a TypeError.
    return { code: 'network', message: 'Could not reach the playback provider.', recoverable: true, providerId };
  }
  return {
    code: 'provider-error',
    message: 'The playback provider returned an unexpected error.',
    recoverable: true,
    providerId,
  };
}

/**
 * Build a Vidsrc/VSEmbed adapter bound to a configuration. Defaults to the
 * shared {@link VIDSRC_PROVIDER_CONFIG}; tests inject variants (disabled,
 * different allowlist) to exercise the contract.
 */
export function createVidsrcAdapter(config: ProviderConfig = VIDSRC_PROVIDER_CONFIG): ProviderAdapter {
  return {
    id: config.id,
    displayName: config.displayName,

    async resolve(request: PlaybackRequest): Promise<PlaybackSource[]> {
      // A disabled provider yields no source (rather than throwing) so the
      // registry can fall through to the next provider cleanly.
      if (!config.enabled) return [];

      const url = buildVidsrcUrl(config, request); // may throw ProviderError
      const scope =
        request.type === 'tv'
          ? request.season !== undefined && request.episode !== undefined
            ? 'episode'
            : 'series'
          : 'movie';

      const source: PlaybackSource = {
        id: `${config.id}:${scope}`,
        label: config.displayName,
        kind: 'embed',
        url,
        capabilities: vidsrcCapabilities(request.type),
        providerId: config.id,
        providerLabel: config.displayName,
        external: true,
        consentRequired: config.consentRequired,
      };
      return [source];
    },

    async healthCheck(): Promise<HealthResult> {
      const checkedAt = new Date().toISOString();
      if (!config.enabled) {
        return { providerId: config.id, status: 'disabled', checkedAt, detail: 'Provider is disabled in configuration.' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      const start = Date.now();
      try {
        // Probe only the base origin — never a content URL, never with a query
        // string or token. `redirect: 'manual'` avoids following off-host hops.
        const res = await fetch(config.baseUrl, { method: 'HEAD', signal: controller.signal, redirect: 'manual' });
        const latencyMs = Date.now() - start;
        // Any non-server-error response means the origin is reachable.
        const status: HealthStatus = res.status < 500 ? 'healthy' : 'degraded';
        return { providerId: config.id, status, latencyMs, checkedAt };
      } catch (error) {
        const normalized = normalizeVidsrcError(error, config.id);
        return {
          providerId: config.id,
          status: 'unavailable',
          checkedAt,
          detail: normalized.code === 'timeout' ? 'Provider health probe timed out.' : 'Provider health probe failed.',
        };
      } finally {
        clearTimeout(timer);
      }
    },

    normalizeError(error: unknown): PlaybackError {
      return normalizeVidsrcError(error, config.id);
    },
  };
}

/** Shared default adapter instance for the registry. */
export const vidsrcAdapter: ProviderAdapter = createVidsrcAdapter(VIDSRC_PROVIDER_CONFIG);
