/**
 * Normalized provider adapter contract (Spec Section 9: PLAYER AND PROVIDER SYSTEM).
 *
 * Every playback provider — native MP4/HLS/DASH, official YouTube/Vimeo embeds,
 * authorized VSEmbed-style embeds, allowlisted iframes, or versioned custom
 * adapters — is normalized behind `ProviderAdapter` so the player UI and source
 * selection logic never depend on a provider's private shape. These are the
 * client-safe DTOs: they must never carry service-role keys, provider secrets,
 * or full private URLs with tokens.
 */

export type SourceKind = 'mp4' | 'hls' | 'dash' | 'youtube' | 'iframe' | 'embed' | 'custom';

export type PlaybackType = 'movie' | 'tv';

/** A selectable quality rung reported by a provider that exposes one. */
export interface Quality {
  id: string;
  /** Human label, e.g. "Auto", "1080p", "720p". */
  label: string;
  /** Vertical resolution in pixels when known. */
  height?: number;
  bitrateKbps?: number;
  /** True for adaptive/"Auto" streams. */
  auto?: boolean;
}

/** A subtitle/caption track reference (BCP-47 language). */
export interface Track {
  id: string;
  label: string;
  language: string;
  kind: 'subtitles' | 'captions';
  /** Sidecar URL when the provider exposes a real track file. */
  url?: string;
  default?: boolean;
}

/**
 * What a resolved source can actually do. Drives the player UI honestly — we
 * never advertise a control the provider does not support. Embed providers
 * typically render their own quality/subtitle menus and do NOT emit reliable
 * telemetry, so `telemetry` stays false for them (Spec Section 9).
 */
export interface Capabilities {
  fullscreen: boolean;
  /** Provider offers in-player quality selection (incl. Auto). */
  qualitySelection: boolean;
  /** Provider offers multi-language subtitles / captions where available. */
  subtitles: boolean;
  /** Provider exposes selectable audio tracks. */
  audioTracks: boolean;
  /** Playback speed control is available. */
  playbackRate: boolean;
  /** Provider exposes TV season/episode selection (built-in picker). */
  episodeSelection: boolean;
  /** Provider maintains its own resume position across sessions. */
  providerResume: boolean;
  /**
   * Provider emits reliable heartbeat/completion events to the host page.
   * Almost always false for iframe/embed providers — Lumora keeps its own
   * watch-progress records regardless.
   */
  telemetry: boolean;
  /** Provider exposes skip-intro / skip-recap markers. */
  skipMarkers: boolean;
}

/**
 * A playback resolution request. The base fields match the spec contract; the
 * external-identifier and TV fields let adapters build provider URLs from a
 * title's TMDB/IMDb id and an optional season/episode.
 */
export interface PlaybackRequest {
  titleId: string;
  episodeId?: string;
  profileId?: string;
  season?: number;
  episode?: number;
  /** IMDb id (e.g. "tt1375666"). Preferred when present and valid. */
  imdbId?: string;
  /** Numeric TMDB id (e.g. "27205"). */
  tmdbId?: string;
  type: PlaybackType;
}

/**
 * A sanitized, client-safe playback source. For embed providers `url` is a
 * fully-validated iframe URL pointing at an allowlisted host (no tokens/query
 * secrets). `providerId`/`providerLabel`/`external`/`consentRequired` are safe
 * metadata used for diagnostics, explicit external-provider labeling, and the
 * consent gate.
 */
export interface PlaybackSource {
  id: string;
  label: string;
  kind: SourceKind;
  url?: string;
  manifestUrl?: string;
  qualities?: Quality[];
  subtitles?: Track[];
  capabilities: Capabilities;
  /** Provider that produced this source (safe to record/log). */
  providerId?: string;
  /** Display name for explicit "played via …" labeling. */
  providerLabel?: string;
  /** True when playback is delegated to an external embed provider. */
  external?: boolean;
  /** True when the viewer must explicitly opt in before the iframe loads. */
  consentRequired?: boolean;
}

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'disabled' | 'unknown';

export interface HealthResult {
  providerId: string;
  status: HealthStatus;
  /** Round-trip latency of the probe, when measured. */
  latencyMs?: number;
  /** ISO-8601 timestamp of the probe. */
  checkedAt: string;
  /** Safe, user-presentable detail — never a URL or token. */
  detail?: string;
}

export type PlaybackErrorCode =
  | 'provider-disabled'
  | 'invalid-request'
  | 'unsupported'
  | 'host-not-allowed'
  | 'consent-required'
  | 'region-blocked'
  | 'timeout'
  | 'network'
  | 'provider-error'
  | 'not-found'
  | 'unknown';

/**
 * A normalized, client-safe error. `message` is always safe to display/log —
 * adapters must never place query strings, tokens, or full private URLs here.
 */
export interface PlaybackError {
  code: PlaybackErrorCode;
  message: string;
  /** Whether the viewer can retry or pick an alternate authorized source. */
  recoverable: boolean;
  providerId?: string;
  cause?: unknown;
}

/**
 * Typed error thrown by adapters (notably server-side URL building) so callers
 * and unit tests can assert on `code`/`recoverable`. Carries only safe fields.
 */
export class ProviderError extends Error {
  readonly code: PlaybackErrorCode;
  readonly recoverable: boolean;
  readonly providerId?: string;

  constructor(params: {
    code: PlaybackErrorCode;
    message: string;
    recoverable: boolean;
    providerId?: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = 'ProviderError';
    this.code = params.code;
    this.recoverable = params.recoverable;
    this.providerId = params.providerId;
    // Keep `instanceof` working regardless of transpilation target.
    Object.setPrototypeOf(this, ProviderError.prototype);
  }

  toPlaybackError(): PlaybackError {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      providerId: this.providerId,
    };
  }
}

/** The normalized adapter every provider implements (Spec Section 9). */
export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Resolve zero or more sanitized sources for a request. May throw ProviderError. */
  resolve(request: PlaybackRequest): Promise<PlaybackSource[]>;
  /** Lightweight liveness probe. Must not throw; returns a HealthResult. */
  healthCheck(): Promise<HealthResult>;
  /** Map any thrown value to a safe, normalized PlaybackError. */
  normalizeError(error: unknown): PlaybackError;
}
