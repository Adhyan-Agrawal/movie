/**
 * External identifiers used for playback resolution.
 *
 * Real `titles` rows carry `tmdb_id`/`imdb_id` (Spec Section 7) and are read
 * straight off the client-safe `Title` DTO. Titles without external ids simply
 * resolve to an empty result, which the provider registry surfaces honestly as
 * the "Playback currently unavailable" state.
 */

import type { Title } from '@/features/catalog/types';

export interface TitleExternalIds {
  tmdbId?: string;
  imdbId?: string;
}

/**
 * Resolve the external ids used for playback, reading only the title's OWN
 * ids from the DTO. No fabricated fallbacks: a title without external ids
 * cannot resolve a playback source.
 */
export function resolveTitleExternalIds(title: Pick<Title, 'id' | 'tmdbId' | 'imdbId'>): TitleExternalIds {
  const ids: TitleExternalIds = {};
  if (title.tmdbId) ids.tmdbId = title.tmdbId;
  if (title.imdbId) ids.imdbId = title.imdbId;
  return ids;
}
