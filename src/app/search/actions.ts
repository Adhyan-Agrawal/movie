'use server';

import { listTitles } from '@/features/catalog/queries';
import type { Title } from '@/features/catalog/types';
import { searchPeople } from '@/features/people/queries';
import type { PersonSearchResult } from '@/features/people/types';

/**
 * Read-only public search. Empty results never trigger catalog imports;
 * deliberate imports remain in the permission-gated admin actions.
 * Provider credentials stay off the client bundle.
 */
export async function searchTitlesAction(query: string): Promise<Title[]> {
  const q = query.trim();
  if (!q) return [];

  return listTitles({ query: q, sort: 'score', limit: 24 });
}

/**
 * Read-only search for the "People" group, returning up to 8 client-safe DTOs.
 */
export async function searchPeopleAction(query: string): Promise<PersonSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  return searchPeople(q, 8);
}
