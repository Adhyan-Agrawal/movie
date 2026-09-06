'use server';

import { listTitles } from '@/features/catalog/queries';
import type { Title } from '@/features/catalog/types';

/**
 * Server action backing the search box (Section 4: "Use indexed PostgreSQL
 * search first"). `listTitles` reads the live catalog when Supabase is
 * configured — its repository path uses a trigram-indexed ILIKE on `titles.name`
 * (`titles_name_trgm_idx`), with the mock catalog as fallback. Kept off the
 * client bundle so DB credentials never leak to the browser.
 */
export async function searchTitlesAction(query: string): Promise<Title[]> {
  const q = query.trim();
  if (!q) return [];
  return listTitles({ query: q, sort: 'score' });
}
