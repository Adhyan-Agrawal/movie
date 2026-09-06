/**
 * Catalog domain types (Section 7).
 * These mirror the shape of the future `titles` table but are the client-safe
 * DTOs — no service-role data, no raw provider secrets.
 */

export type TitleType = 'movie' | 'tv';

export type MaturityRating = 'G' | 'PG' | 'PG-13' | 'R' | 'NC-17' | 'TV-MA' | 'TV-14' | 'TV-PG';

export interface Title {
  id: string;
  type: TitleType;
  slug: string;
  name: string;
  /** Optional original-language name shown as secondary metadata. */
  originalName?: string;
  synopsis: string;
  releaseYear: number;
  /** Runtime in minutes (movies) or average episode runtime (tv). */
  runtimeMinutes?: number;
  maturity: MaturityRating;
  genres: string[];
  posterUrl?: string;
  backdropUrl?: string;
  trailerUrl?: string;
  /** 0..100 editorial/community score used for badges and sorting. */
  score?: number;
  featured?: boolean;
  /** TMDB id (numeric, as string) used for playback resolution (Section 7/9). */
  tmdbId?: string;
  /** IMDb id (`tt…`) used for playback resolution when present. */
  imdbId?: string;
}

export interface WatchProgress {
  titleId: string;
  /** 0..1 fraction watched. */
  progress: number;
  /** Seconds into the media, for resume. */
  positionSeconds: number;
  updatedAt: string;
}

export interface ContinueWatchingEntry {
  title: Title;
  progress: WatchProgress;
}

export interface MediaRow {
  id: string;
  heading: string;
  /** Human-readable reason for personalized rows (Section 13). */
  reason?: string;
  titles: Title[];
}

/** One episode row (client-safe DTO). */
export interface Episode {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string;
  /** ISO date (YYYY-MM-DD) or null when unaired/unknown. */
  airDate: string | null;
  runtimeMinutes: number | null;
  stillUrl: string | null;
}

/** One season with its imported episode rows (`episodes` may be empty —
 * `episodeCount` then carries the honest "N episodes" count). */
export interface Season {
  id: string;
  seasonNumber: number;
  name: string | null;
  overview: string;
  airDate: string | null;
  episodeCount: number | null;
  episodes: Episode[];
}

/** One cast credit joined with its person row (client-safe DTO). */
export interface CastMember {
  personId: string;
  name: string;
  character: string | null;
  profileUrl: string | null;
}
