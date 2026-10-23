import type {
  Capabilities,
  HealthResult,
  PlaybackError,
  PlaybackRequest,
  PlaybackSource,
  ProviderAdapter,
} from './types';
import { ProviderError } from './types';
import type { ProviderConfig } from './config';

const TMDB_ID_RE = /^\d{1,12}$/;
const MAX_DIRECT_SOURCES = 11;

const capabilities: Capabilities = {
  fullscreen: true,
  qualitySelection: true,
  subtitles: true,
  audioTracks: true,
  playbackRate: true,
  episodeSelection: false,
  providerResume: false,
  telemetry: true,
  skipMarkers: false,
};

function normalizeError(error: unknown, providerId: string): PlaybackError {
  if (error instanceof ProviderError) return error.toPlaybackError();
  return {
    code: 'provider-error',
    message: 'The playback provider returned an unexpected error.',
    recoverable: true,
    providerId,
  };
}

export function createVidnestAdapter(config: ProviderConfig): ProviderAdapter {
  return {
    id: config.id,
    displayName: config.displayName,

    async resolve(request: PlaybackRequest): Promise<PlaybackSource[]> {
      if (!config.enabled) return [];
      if (!request.tmdbId || !TMDB_ID_RE.test(request.tmdbId)) {
        throw new ProviderError({
          code: 'invalid-request',
          message: 'A valid TMDB identifier is required for this provider.',
          recoverable: true,
          providerId: config.id,
        });
      }
      if (request.type === 'tv' && (request.season === undefined || request.episode === undefined)) {
        throw new ProviderError({
          code: 'invalid-request',
          message: 'A season and episode are required for TV playback.',
          recoverable: true,
          providerId: config.id,
        });
      }

      const params = new URLSearchParams({ tmdbId: request.tmdbId, type: request.type });
      if (request.type === 'tv') {
        params.set('season', String(request.season));
        params.set('episode', String(request.episode));
      }

      return Array.from({ length: MAX_DIRECT_SOURCES }, (_, streamIndex) => {
        const sourceParams = new URLSearchParams(params);
        sourceParams.set('stream', String(streamIndex));
        const label = streamIndex === 0 ? config.displayName : `${config.displayName} ${streamIndex + 1}`;

        return {
          id: `${config.id}:${request.type}:${streamIndex}`,
          label,
          kind: 'hls' as const,
          url: `/api/vidnest?${sourceParams}`,
          capabilities,
          providerId: config.id,
          providerLabel: label,
          external: true,
          consentRequired: config.consentRequired,
        };
      });
    },

    async healthCheck(): Promise<HealthResult> {
      const checkedAt = new Date().toISOString();
      if (!config.enabled) return { providerId: config.id, status: 'disabled', checkedAt };

      try {
        const baseUrl = new URL(config.baseUrl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
        const start = Date.now();
        const response = await fetch(baseUrl, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
        clearTimeout(timeout);
        return {
          providerId: config.id,
          status: response.status < 500 ? 'healthy' : 'degraded',
          latencyMs: Date.now() - start,
          checkedAt,
        };
      } catch {
        return { providerId: config.id, status: 'unavailable', checkedAt, detail: 'Provider health probe failed.' };
      }
    },

    normalizeError(error: unknown): PlaybackError {
      return normalizeError(error, config.id);
    },
  };
}
