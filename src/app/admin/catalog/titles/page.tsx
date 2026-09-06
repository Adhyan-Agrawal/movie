import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { TitlesTable } from '@/features/admin/TitlesTable';
import { listAdminTitles } from '@/features/admin/queries';
import type { TitleType } from '@/features/catalog/types';
import { cn } from '@/lib/cn';

export const metadata = {
  title: 'Catalog',
  description: 'Browse the live catalog of titles.',
};

/**
 * Admin catalog titles (Spec Section 10). The listing is paged in-DB
 * (`.range()` + an exact count) rather than fetched as one array, so the page
 * shows the TRUE catalog total instead of silently stopping at Supabase's
 * default 1,000-row cap. Search and the type filter are plain URL params —
 * the search form is a GET form and the filters are `Link`s, so the whole
 * surface works without client JS. Publish/archive/delete remain affordances
 * only until the catalog-management phase lands.
 */

/** Titles per page. */
const PAGE_SIZE = 50;

/** Next 15 resolves `searchParams` to this shape. */
type SearchParamsRecord = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Serialize the listing state back into a path (page 1 stays implicit). */
function listingHref({ q, type, page }: { q: string; type?: TitleType; page: number }): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (type) params.set('type', type);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/admin/catalog/titles?${qs}` : '/admin/catalog/titles';
}

const TYPE_FILTERS: ReadonlyArray<{ value?: TitleType; label: string }> = [
  { label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'tv', label: 'Series' },
];

/**
 * Compact page-number window: always the first and last page with a few
 * around the current one; `'gap'` entries render as ellipses. Keeps the pager
 * readable even at ~70 pages (3,400+ titles / 50 per page).
 */
function pageWindow(current: number, pageCount: number): Array<number | 'gap'> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const items: Array<number | 'gap'> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(pageCount - 1, current + 1);
  if (start > 2) items.push('gap');
  for (let p = start; p <= end; p += 1) items.push(p);
  if (end < pageCount - 1) items.push('gap');
  items.push(pageCount);
  return items;
}

export default async function AdminCatalogTitlesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const sp = await searchParams;

  const q = firstParam(sp.q)?.trim() ?? '';
  const rawType = firstParam(sp.type);
  const type: TitleType | undefined = rawType === 'movie' || rawType === 'tv' ? rawType : undefined;
  const requestedPage = Math.max(1, Number.parseInt(firstParam(sp.page) ?? '1', 10) || 1);

  let page = requestedPage;
  let result = await listAdminTitles({ query: q || undefined, page, pageSize: PAGE_SIZE, type });

  // A page number past the end (e.g. after a search narrowed the results)
  // would render an empty table against a non-zero total; snap to the last
  // page so the table and the pager agree.
  if (result.rows.length === 0 && result.total > 0 && page > 1) {
    page = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
    result = await listAdminTitles({ query: q || undefined, page, pageSize: PAGE_SIZE, type });
  }

  const { rows, total } = result;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstShown = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(page * PAGE_SIZE, total);

  const emptyTitle = q
    ? `No titles match “${q}”`
    : type === 'movie'
      ? 'No movies in the catalog yet'
      : type === 'tv'
        ? 'No series in the catalog yet'
        : 'No titles in the catalog yet';
  const emptyDescription = q
    ? 'Try a different search term, or clear the search to browse the full catalog.'
    : 'Run the TMDB sync (Catalog → Sync) to import titles — they will appear here.';

  const pageLinkClasses = (active: boolean) =>
    buttonClasses({ variant: active ? 'primary' : 'secondary', size: 'sm' });
  const disabledPageClasses = cn(pageLinkClasses(false), 'pointer-events-none opacity-40');

  return (
    <div className="flex flex-col gap-6 py-6">
      <PageHeader
        title="Catalog · Titles"
        description="Titles from the live catalog (catalog.read), paged straight from the database — the count below is the true total, drafts included. Publish, archive, and delete actions arrive with the catalog-management phase."
      />

      {/* Search + type filter. The URL is the source of truth: a GET form and
          Link-based filters, no client JS required. Any new search or filter
          change naturally returns to page 1. */}
      <section
        aria-label="Search and filter titles"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface/50 p-3 shadow-soft md:p-4"
      >
        <form method="get" action="/admin/catalog/titles" role="search" className="flex flex-wrap items-end gap-3">
          <label htmlFor="admin-title-search" className="flex w-full flex-col gap-1.5 sm:max-w-md">
            <span className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">Search</span>
            <input
              id="admin-title-search"
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search titles by name…"
              className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-sm text-content shadow-soft transition-colors hover:border-border-strong focus:border-primary focus-visible:outline-none"
            />
          </label>
          {/* Keep the active type filter across searches; page resets on submit. */}
          {type ? <input type="hidden" name="type" value={type} /> : null}
          <button type="submit" className={buttonClasses({ variant: 'primary' })}>
            Search
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">Type</span>
          {TYPE_FILTERS.map((f) => (
            <Link
              key={f.label}
              href={listingHref({ q, type: f.value, page: 1 })}
              aria-current={f.value === type ? 'true' : undefined}
              className={pageLinkClasses(f.value === type)}
            >
              {f.label}
            </Link>
          ))}
          {q ? (
            <Link
              href={listingHref({ q: '', type, page: 1 })}
              className={cn(buttonClasses({ variant: 'ghost', size: 'sm' }), 'ml-auto')}
            >
              Clear search
            </Link>
          ) : null}
        </div>
      </section>

      {total === 0 ? (
        <EmptyState
          icon="⛃"
          title={emptyTitle}
          description={emptyDescription}
          action={
            q ? (
              <Link href={listingHref({ q: '', type, page: 1 })} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
                Clear search
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <p className="text-sm text-content-muted" aria-live="polite">
            {`Showing ${firstShown.toLocaleString()}–${lastShown.toLocaleString()} of ${total.toLocaleString()} titles`}
            {q ? ` matching “${q}”` : ''}
            {type ? (type === 'movie' ? ' · movies' : ' · series') : ''}
          </p>

          <TitlesTable titles={rows} />

          {pageCount > 1 ? (
            <nav
              aria-label="Pagination"
              className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between"
            >
              {page > 1 ? (
                <Link href={listingHref({ q, type, page: page - 1 })} rel="prev" className={pageLinkClasses(false)}>
                  ← Previous
                </Link>
              ) : (
                <span aria-disabled="true" className={disabledPageClasses}>
                  ← Previous
                </span>
              )}

              <ul className="flex flex-wrap items-center justify-center gap-1.5">
                <li className="sr-only">{`Page ${page} of ${pageCount}`}</li>
                {pageWindow(page, pageCount).map((p, index) =>
                  p === 'gap' ? (
                    <li key={`gap-${index}`} aria-hidden="true" className="px-1 text-sm text-content-subtle">
                      …
                    </li>
                  ) : p === page ? (
                    <li key={p}>
                      <span aria-current="page" className={pageLinkClasses(true)}>
                        {p.toLocaleString()}
                      </span>
                    </li>
                  ) : (
                    <li key={p}>
                      <Link href={listingHref({ q, type, page: p })} className={pageLinkClasses(false)}>
                        {p.toLocaleString()}
                      </Link>
                    </li>
                  ),
                )}
              </ul>

              {page < pageCount ? (
                <Link href={listingHref({ q, type, page: page + 1 })} rel="next" className={pageLinkClasses(false)}>
                  Next →
                </Link>
              ) : (
                <span aria-disabled="true" className={disabledPageClasses}>
                  Next →
                </span>
              )}
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
