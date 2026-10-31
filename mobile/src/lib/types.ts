/**
 * Shared DTOs for the native app. Mirrors the web catalog types
 * (src/features/catalog/types.ts) so both clients speak the same shapes.
 */

export type TitleType = 'movie' | 'tv';
export type MaturityRating = 'G' | 'PG' | 'PG-13' | 'R' | 'NC-17' | 'TV-MA' | 'TV-14' | 'TV-PG';

export interface Title {
  id: string;
  type: TitleType;
  slug: string;
  name: string;
  originalName?: string;
  originalLanguage?: string;
  originCountries?: string[];
  synopsis: string;
  releaseYear: number;
  runtimeMinutes?: number;
  maturity: MaturityRating;
  genres: string[];
  posterUrl?: string;
  backdropUrl?: string;
  trailerUrl?: string;
  score?: number;
  tmdbId?: string;
  imdbId?: string;
}

export interface Episode {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string;
  airDate: string | null;
  runtimeMinutes: number | null;
  stillUrl: string | null;
}

export interface Season {
  id: string;
  seasonNumber: number;
  name: string | null;
  overview: string;
  airDate: string | null;
  episodeCount: number | null;
  episodes: Episode[];
}

export interface CastMember {
  personId: string;
  name: string;
  character: string | null;
  profileUrl: string | null;
}

export interface Person {
  id: string;
  name: string;
  knownFor: string | null;
  profileUrl: string | null;
}

export interface MediaRow {
  id: string;
  heading: string;
  reason?: string;
  titles: Title[];
  href?: string;
  collectionId?: string;
  filters?: TitleFilters;
}

export interface TitleFilters {
  type?: TitleType;
  genre?: string;
  sort?: 'trending' | 'newest' | 'oldest' | 'az' | 'score';
  originalLanguage?: string;
  country?: string;
}

export interface HomeData {
  hero: Title[];
  rows: MediaRow[];
  collections?: Array<{ id: string; label: string; href: string; filters: TitleFilters }>;
}

/** A playable source, already anonymized to "Server N" by the web bridge. */
export interface PlaybackSource {
  id: string;
  label: string;
  url: string;
  kind: 'embed' | 'hls' | 'mp4' | 'dash';
  consentRequired: boolean;
  streamCatalogUrl?: string;
}

export interface Quality {
  id: string;
  label: string;
  height?: number;
  width?: number;
  bitrateKbps?: number;
  auto?: boolean;
}

export interface MediaTrack {
  id: string;
  label: string;
  language: string;
  default?: boolean;
}

export interface Subtitle extends MediaTrack {
  kind?: 'subtitles' | 'captions';
  /** Only genuine VTT sidecars have a URL, never HLS subtitle playlists. */
  url?: string;
}

export interface DirectStream {
  id: string;
  url: string;
  startupLatencyMs?: number;
  qualities: Quality[];
  audioTracks: MediaTrack[];
  subtitles: Subtitle[];
}

export interface StreamCatalog {
  streams: DirectStream[];
  recommendedStreamId?: string;
}

/** Optional bridge extensions. Native ad execution is supplied separately. */
export interface PlaybackResponse {
  sources: PlaybackSource[];
  subtitleCatalogUrl?: string;
  introCatalogUrl?: string;
  adPolicy?: NativeAdPolicy;
  entitlements?: ViewerEntitlements;
}

export interface IntroMarker {
  startSeconds: number;
  endSeconds: number;
}

/** Mirrors the public commerce DTO; missing entitlements never imply ad eligibility. */
export interface ViewerEntitlements {
  resolved: boolean;
  adFree: boolean;
  maxProfiles: number;
  status: 'free' | 'active' | 'expired' | 'unavailable';
  planId?: string;
  planName?: string;
  accessUntil?: string;
}

export interface NativeAdPolicy {
  enabled: boolean;
  firstBreakSeconds: number;
  intervalSeconds: number;
  maxBreaks: number;
  allowSkip: boolean;
  skipAfterSeconds: number;
}

export type NativeVastTrackingEvent = 'impression' | 'start' | 'firstQuartile' | 'midpoint' | 'thirdQuartile' | 'complete' | 'skip' | 'error';

export interface NativeVastCreative {
  id: string;
  mediaUrl: string;
  durationSeconds: number;
  skipAfterSeconds: number | null;
  tracking: Partial<Record<NativeVastTrackingEvent, string[]>>;
  clickThrough?: string;
  clickTracking?: string[];
}

export interface PlaybackRequest {
  type: TitleType;
  /** Catalog ids — let the bridge include Lumora-hosted (native) sources. */
  titleId?: string;
  episodeId?: string;
  tmdbId?: string;
  imdbId?: string;
  season?: number;
  episode?: number;
  /** Saved position (seconds) to resume from, where the provider supports it. */
  start?: number;
}

/** A continue-watching entry (title + where the viewer left off). */
export interface ContinueEntry {
  title: Title;
  progress?: number;
  positionSeconds?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeId?: string;
}
