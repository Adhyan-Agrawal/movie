import type { Title } from '@/features/catalog/types';

/**
 * People domain types (real actors/directors linked from `title_people`).
 *
 * Client-safe DTOs — the same posture as `catalog/types.ts`: no service-role
 * fields, no raw provider data. A person row in `people` is intentionally
 * small (identity + a TMDB-hosted photo + a free-text "known for" blurb); the
 * interesting surface is their credits, which resolve to full catalog `Title`
 * DTOs so existing UI (MediaCard, title links) can be reused as-is.
 */

/** A real person (actor / director / crew) in the catalog. */
export interface Person {
  id: string;
  name: string;
  /** TMDB "known for" department / blurb (e.g. "Acting", "Directing"). */
  knownFor: string | null;
  profileUrl: string | null;
}

/**
 * A person search result. `roleCount` is the number of PUBLIC credits the
 * person has in the catalog (cast + crew) when the query could cheaply compute
 * it — it is cosmetic, so it is optional and never blocks a result.
 */
export type PersonSearchResult = Person & { roleCount?: number };

/** Credit kind — mirrors the DB `credit_type` check ('cast' | 'crew'). */
export type PersonCreditType = 'cast' | 'crew';

/**
 * One row in `title_people` for a person, joined to its public title. `title`
 * is a full `Title` DTO so it can feed MediaCard / title links directly.
 */
export interface PersonCredit {
  title: Title;
  creditType: PersonCreditType;
  /** Role name for cast credits; null for crew. */
  character: string | null;
  /** Department job for crew credits (e.g. "Director"); null for cast. */
  job: string | null;
  /** Billing order within the title (0 = top-billed). */
  creditOrder: number;
}
