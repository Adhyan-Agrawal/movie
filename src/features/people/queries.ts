import { features } from '@/lib/env';
import type { Person, PersonCredit, PersonSearchResult } from './types';

/**
 * Read API over people (Spec Section 6: services -> repositories).
 *
 * Same posture as `@/features/catalog/queries`: every read is delegated to a
 * server-only repository through a dynamic import, so the DB client is never
 * bundled into a client component that happens to import a type from this
 * file. RLS applies on every call — anonymous visitors read public people rows
 * and public-title credits only. Failures degrade to honest empty results
 * (`[]` / `null`) instead of 500-ing the page.
 */

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

/** Single person by UUID. Returns null for unknown ids or when unconfigured. */
export async function getPerson(id: string): Promise<Person | null> {
  if (!features.supabaseConfigured) return null;
  try {
    const { repoGetPerson } = await import('@/features/catalog/repository');
    return await repoGetPerson(id);
  } catch (err) {
    warnFailure('getPerson', err);
    return null;
  }
}

/**
 * A person's credits joined to public titles (full Title DTOs). Returns [] for
 * a person with no visible credits, an unknown id, or when unconfigured.
 */
export async function getPersonCredits(id: string): Promise<PersonCredit[]> {
  if (!features.supabaseConfigured) return [];
  try {
    const { repoListPersonCredits } = await import('@/features/catalog/repository');
    return await repoListPersonCredits(id);
  } catch (err) {
    warnFailure('getPersonCredits', err);
    return [];
  }
}
