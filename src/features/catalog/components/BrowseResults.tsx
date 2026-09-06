import Link from 'next/link';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';
import { listTitles } from '@/features/catalog/queries';
import type { TitleFilters } from '@/features/catalog/queries';
import type { TitleType } from '@/features/catalog/types';
import { FilterBar } from './FilterBar';
import { TitleGrid } from './TitleGrid';

/** Next 15 resolves `searchParams` to this shape. */
export type SearchParamsRecord = Record<string, string | string[] | undefined>;

const PAGE_SIZE = 12;
const SORTS = ['trending', 'newest', 'oldest', 'az', 'score'] as const;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse URL search params into {@link TitleFilters} (URL is the source of
 * truth, Section 4). Unknown/invalid values are dropped rather than trusted.
 * Callers may override locked dimensions afterwards (e.g. `type` on /movies).
 */
export function parseTitleFilters(sp: SearchParamsRecord): TitleFilters {
  const filters: TitleFilters = {};

  const type = first(sp.type);
  if (type === 'movie' || type === 'tv') filters.type = type;

  const genre = first(sp.genre);
  if (genre) filters.genre = genre;

  const minYear = toInt(first(sp.minYear));
  if (minYear) filters.minYear = minYear;

  const maxYear = toInt(first(sp.maxYear));
  if (maxYear) filters.maxYear = maxYear;

  const maturity = first(sp.maturity);
  if (maturity) filters.maturity = maturity;

  const query = first(sp.q)?.trim();
  if (query) filters.query = query;

  const sort = SORTS.find((s) => s === first(sp.sort));
  if (sort) filters.sort = sort;

  return filters;
}

function toParams(sp: SearchParamsRecord): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    const v = first(value);
    if (v !== undefined && v !== '') params.set(key, v);
  }
  return params;
}

function pageHref(basePath: string, sp: SearchParamsRecord, page: number): string {
  const params = toParams(sp);
  if (page > 1) params.set('page', String(page));
  else params.delete('page');
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * Shared browse body: filter bar + results grid + pagination. Reused by
 * /browse, /movies, /tv, and /genre/[slug] so pagination and slicing live in
 * one place. Pagination is a client-side slice by the `page` param (12/page)
 * with proper disabled prev/next states.
 */
export async function BrowseResults({
  filters,
  sp,
  basePath,
  genres,
  lockType,
  lockGenre,
}: {
  filters: TitleFilters;
  sp: SearchParamsRecord;
  basePath: string;
  genres: string[];
  lockType?: TitleType;
  lockGenre?: string;
}) {
  const all = await listTitles(filters);
  const total = all.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requested = toInt(first(sp.page)) ?? 1;
  const current = Math.min(Math.max(1, requested), pageCount);
  const slice = all.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const disabledClass = cn(buttonClasses({ variant: 'secondary' }), 'pointer-events-none opacity-40');

  return (
    <div className="flex flex-col gap-6 pb-10">
      <FilterBar genres={genres} lockType={lockType} lockGenre={lockGenre} />
      <TitleGrid titles={slice} totalCount={total} resetHref={basePath} />

      {pageCount > 1 ? (
        <nav aria-label="Pagination" className="flex items-center justify-between gap-4 border-t border-border pt-4">
          {current > 1 ? (
            <Link href={pageHref(basePath, sp, current - 1)} rel="prev" className={buttonClasses({ variant: 'secondary' })}>
              ← Previous
            </Link>
          ) : (
            <span aria-disabled="true" className={disabledClass}>
              ← Previous
            </span>
          )}

          <span className="text-sm text-content-muted" aria-live="polite">
            Page {current} of {pageCount}
          </span>

          {current < pageCount ? (
            <Link href={pageHref(basePath, sp, current + 1)} rel="next" className={buttonClasses({ variant: 'secondary' })}>
              Next →
            </Link>
          ) : (
            <span aria-disabled="true" className={disabledClass}>
              Next →
            </span>
          )}
        </nav>
      ) : null}
    </div>
  );
}
