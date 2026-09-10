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
}

/** A playable source, already anonymized to "Server N" by the web bridge. */
export interface PlaybackSource {
  id: string;
  label: string;
  url: string;
  kind: 'embed' | 'hls' | 'mp4' | 'dash';
  consentRequired: boolean;
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
