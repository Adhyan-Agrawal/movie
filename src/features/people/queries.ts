import { cache } from 'react';
import { features } from '@/lib/env';
import type { Person, PersonCredit, PersonSearchResult } from './types';

/**
 * Read API over people (Spec Section 6: services -> repositories).
 *
 * Explicit TMDB identities read public provider metadata only. UUID identities
 * keep the repository's RLS/public-title behavior and empty-result failure
 * contract. Public upstream failures propagate, never triggering a DB replica.
 * React cache shares reads within a render, not across viewers or requests.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TMDB_PERSON_RE = /^tmdb:person:[1-9][0-9]{0,9}$/;

export function isPersonId(id: string): boolean {
  return UUID_RE.exec(id)?.[0] === id || TMDB_PERSON_RE.exec(id)?.[0] === id;
}

/** Log a repository failure once (safe diagnostics only). */
function warnFailure(fn: string, err: unknown): void {
  console.warn(`people.${fn}: repository failed, returning empty result`, {
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Case-insensitive person search by name. Returns up to `limit` matches;
 * empty query / unconfigured Supabase yield `[]`.
 */
export async function searchPeople(query: string, limit = 8): Promise<PersonSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  if (!features.supabaseConfigured) return [];
  try {
    const { repoSearchPeople } = await import('@/features/catalog/repository');
    return await repoSearchPeople(q, limit);
  } catch (err) {
    warnFailure('searchPeople', err);
    return [];
  }
}

/** Single person by UUID or canonical TMDB identity. */
export const getPerson = cache(async (id: string): Promise<Person | null> => {
  if (id.startsWith('tmdb:')) {
    if (!isPersonId(id) || !features.tmdbConfigured) return null;
    const { getTmdbPerson } = await import('@/features/catalog/tmdb-catalog');
    return (await getTmdbPerson(id))?.person ?? null;
  }
  if (!isPersonId(id) || !features.supabaseConfigured) return null;
  try {
    const { repoGetPerson } = await import('@/features/catalog/repository');
    return await repoGetPerson(id);
  } catch (err) {
    warnFailure('getPerson', err);
    return null;
  }
});

/**
 * A person's credits joined to public titles (full Title DTOs). Returns [] for
 * a person with no visible credits, an unknown id, or when unconfigured.
 */
export const getPersonCredits = cache(async (id: string): Promise<PersonCredit[]> => {
  if (id.startsWith('tmdb:')) {
    if (!isPersonId(id) || !features.tmdbConfigured) return [];
    const { getTmdbPerson } = await import('@/features/catalog/tmdb-catalog');
    return (await getTmdbPerson(id))?.credits ?? [];
  }
  if (!isPersonId(id) || !features.supabaseConfigured) return [];
  try {
    const { repoListPersonCredits } = await import('@/features/catalog/repository');
    return await repoListPersonCredits(id);
  } catch (err) {
    warnFailure('getPersonCredits', err);
    return [];
  }
});
