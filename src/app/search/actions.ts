'use server';

import { listTitles } from '@/features/catalog/queries';
import type { Title } from '@/features/catalog/types';
import { features } from '@/lib/env';

/**
 * Server action backing the search box (Section 4: "Use indexed PostgreSQL
 * search first"). `listTitles` reads the live catalog under RLS — its
 * repository path uses a trigram-indexed ILIKE on `titles.name`
 * (`titles_name_trgm_idx`).
 *
 * SEARCH-TO-TITLE AUTO-IMPORT: when the local catalog has no match, we query
 * TMDB for the same terms, import the top matches (full metadata + artwork,
 * capped per query via the service client — searchers are not catalog editors),
 * and return them. The catalog therefore grows automatically with what users
 * actually look for. TMDB failures degrade silently to local results — search
 * never breaks because the external API is unreachable (e.g. ISP blocks).
 *
 * Kept off the client bundle so DB/provider credentials never leak to the
 * browser.
 */
export async function searchTitlesAction(query: string): Promise<Title[]> {
  const q = query.trim();
  if (!q) return [];

  const local = await listTitles({ query: q, sort: 'score' });
  if (local.length > 0) return local;
  if (!features.supabaseConfigured) return [];

  try {
    const { importTitlesForSearch } = await import('@/features/catalog/tmdb-sync');
    const imported = await importTitlesForSearch(q);
    if (imported.length > 0) {
      // Re-query the local catalog so results flow through the same mapping
      // and RLS path the UI always uses.
      const merged = await listTitles({ query: q, sort: 'score' });
      if (merged.length > 0) return merged;
      // Local re-query can miss short queries (ILIKE) — fall back to mapping
      // the imported titles directly.
      return imported.map((t) => ({
        id: `${t.tmdbId}`,
        type: t.type,
        slug: t.slug,
        name: t.name,
        ...(t.originalName ? { originalName: t.originalName } : {}),
        synopsis: t.synopsis,
        releaseYear: t.releaseYear ?? 0,
        ...(t.runtimeMinutes != null ? { runtimeMinutes: t.runtimeMinutes } : {}),
        maturity: (['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-MA', 'TV-14', 'TV-PG'] as const).includes(
          t.maturity as never,
        )
          ? (t.maturity as Title['maturity'])
          : 'PG-13',
        genres: t.genres,
        ...(t.posterUrl ? { posterUrl: t.posterUrl } : {}),
        ...(t.backdropUrl ? { backdropUrl: t.backdropUrl } : {}),
        ...(t.score != null ? { score: t.score } : {}),
        tmdbId: String(t.tmdbId),
        ...(t.imdbId ? { imdbId: t.imdbId } : {}),
      }));
    }
  } catch {
    // TMDB unreachable / rate-limited — local results only (silent degrade).
  }
  return local;
}
