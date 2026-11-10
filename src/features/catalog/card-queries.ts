import 'server-only';

import { features } from '@/lib/env';
import { getSupabasePublicClient } from '@/lib/supabase/public';
import type { Database } from '@/lib/supabase/types';
import type { Title } from './types';

/** Card-only DTO, compatible with existing cards without fetching detail text/joins. */
export type TitleCard = Pick<Title,
  'id' | 'type' | 'slug' | 'name' | 'releaseYear' | 'runtimeMinutes' | 'maturity' |
  'posterUrl' | 'backdropUrl' | 'score' | 'tmdbId' | 'imdbId'
> & { synopsis: ''; genres: [] };

export type TitleCardRow = Pick<Database['public']['Tables']['titles']['Row'],
  'id' | 'type' | 'slug' | 'name' | 'release_year' | 'runtime_minutes' | 'maturity' |
  'poster_url' | 'backdrop_url' | 'editorial_score' | 'tmdb_id' | 'imdb_id'
>;

export const TITLE_CARD_SELECT =
  'id, type, slug, name, release_year, runtime_minutes, maturity, ' +
  'poster_url, backdrop_url, editorial_score, tmdb_id, imdb_id';

/** At most 50 progress rows plus the existing 200-session fallback window. */
export const MAX_TITLE_CARD_IDS = 250;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TMDB_ID_RE = /^tmdb:(movie|tv):([1-9]\d{0,9})$/;

export function toTitleCard(row: TitleCardRow): TitleCard {
  const validMaturity: readonly Title['maturity'][] = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-MA', 'TV-14', 'TV-PG'];
  return {
    id: row.id, type: row.type, slug: row.slug, name: row.name,
    synopsis: '', genres: [], releaseYear: row.release_year ?? 0,
    maturity: validMaturity.includes(row.maturity as Title['maturity']) ? row.maturity as Title['maturity'] : 'PG-13',
    ...(row.runtime_minutes != null ? { runtimeMinutes: row.runtime_minutes } : {}),
    ...(row.poster_url ? { posterUrl: row.poster_url } : {}),
    ...(row.backdrop_url ? { backdropUrl: row.backdrop_url } : {}),
    ...(row.editorial_score != null ? { score: row.editorial_score } : {}),
    ...(row.tmdb_id != null ? { tmdbId: String(row.tmdb_id) } : {}),
    ...(row.imdb_id ? { imdbId: row.imdb_id } : {}),
  };
}

/** One anonymous published-card query for distinct stored UUIDs; no private list cache. */
export async function getTitleCardsByIds(titleIds: readonly string[]): Promise<ReadonlyMap<string, TitleCard>> {
  const ids = [...new Set(titleIds.filter((id) => UUID_RE.test(id) || TMDB_ID_RE.test(id))
    .map((id) => UUID_RE.test(id) ? id.toLowerCase() : id))].slice(0, MAX_TITLE_CARD_IDS);
  const storedIds = ids.filter((id) => UUID_RE.test(id));
  const cards = new Map<string, TitleCard>();
  const tmdbCatalog = features.tmdbConfigured && ids.some((id) => TMDB_ID_RE.test(id)) ? import('./tmdb-catalog') : null;

  await Promise.all([
    (async () => {
      if (!features.supabaseConfigured || storedIds.length === 0) return;
      try {
        const { data, error } = await getSupabasePublicClient().from('titles')
          .select(TITLE_CARD_SELECT)
          .eq('status', 'published')
          .eq('visibility', 'public')
          .or(`published_at.is.null,published_at.lte.${new Date().toISOString()}`)
          .in('id', storedIds)
          .limit(storedIds.length);
        if (error) throw new Error(error.message);
        for (const row of (data ?? []) as unknown as TitleCardRow[]) cards.set(row.id, toTitleCard(row));
      } catch (error) {
        console.warn('catalog.getTitleCardsByIds: stored cards read failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })(),
    ...ids.filter((id) => TMDB_ID_RE.test(id)).map(async (id) => {
      if (!tmdbCatalog) return;
      const [, type, tmdbId] = id.split(':');
      if (type !== 'movie' && type !== 'tv') return;
      try {
        const { getTmdbTitle } = await tmdbCatalog;
        const title = await getTmdbTitle(type, `${type}-${tmdbId}`);
        if (!title) return;
        cards.set(id, toTitleCard({
          id: title.id, type: title.type, slug: title.slug, name: title.name,
          release_year: title.releaseYear, runtime_minutes: title.runtimeMinutes ?? null,
          maturity: title.maturity, poster_url: title.posterUrl ?? null,
          backdrop_url: title.backdropUrl ?? null, editorial_score: title.score ?? null,
          tmdb_id: title.tmdbId ? Number(title.tmdbId) : null, imdb_id: title.imdbId ?? null,
        }));
      } catch (error) {
        console.warn('catalog.getTitleCardsByIds: TMDB card read failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  ]);
  return new Map(titleIds.flatMap((id) => {
    const card = cards.get(UUID_RE.test(id) ? id.toLowerCase() : id);
    return card ? [[id, card] as const] : [];
  }));
}
