/**
 * Vertical-slice bridge for external identifiers.
 *
 * The real `titles` table will carry a TMDB id (and often an IMDb id) per Spec
 * Section 7, and playback resolution will read them directly. The current mock
 * catalog (`src/features/catalog/mock-data.ts`) predates those fields, and that
 * file is out of scope for this slice. To exercise the Vidsrc adapter
 * end-to-end without editing the catalog feature, this maps a few mock title
 * ids to public example TMDB/IMDb identifiers.
 *
 * Titles WITHOUT a mapping intentionally fall through to the
 * "Playback currently unavailable" state, so both the resolved-source and
 * provider-unavailable paths are demonstrable. Remove this bridge once catalog
 * titles expose real external ids.
 */

import type { Title } from '@/features/catalog/types';

export interface TitleExternalIds {
  tmdbId?: string;
  imdbId?: string;
}

/**
 * Fallback map for the LOCAL MOCK catalog only. Real `titles` rows carry
 * `tmdb_id`/`imdb_id` directly (Spec Section 7) and are read straight off the
 * DTO by `resolveTitleExternalIds` below; this table only covers the fictional
 * mock titles (which have no real external ids) so the adapter is still
 * demonstrable when Supabase is not configured. Mock titles left unmapped fall
 * through to the "playback unavailable" state on purpose.
 */
const MOCK_EXTERNAL_IDS: Record<string, TitleExternalIds> = {
  't-aurora': { tmdbId: '27205' },
  't-nightcall': { imdbId: 'tt0468569' },
  't-lantern': { tmdbId: '1399' },
};

/** Legacy lookup by mock title id (kept for the mock fallback path). */
export function getTitleExternalIds(titleId: string): TitleExternalIds {
  return MOCK_EXTERNAL_IDS[titleId] ?? {};
}

/**
 * Resolve the external ids used for playback. Prefers the title's OWN ids (real
 * catalog rows from Supabase), and only consults the mock bridge when the DTO
 * carries none — i.e. for the local sample catalog.
 */
export function resolveTitleExternalIds(title: Pick<Title, 'id' | 'tmdbId' | 'imdbId'>): TitleExternalIds {
  const ids: TitleExternalIds = {};
  if (title.tmdbId) ids.tmdbId = title.tmdbId;
  if (title.imdbId) ids.imdbId = title.imdbId;
  if (ids.tmdbId || ids.imdbId) return ids;
  return getTitleExternalIds(title.id);
}
