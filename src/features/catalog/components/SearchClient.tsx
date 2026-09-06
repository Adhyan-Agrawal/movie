'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { searchTitlesAction } from '@/app/search/actions';
import { MediaCard } from './MediaCard';
import type { Title } from '../types';

/**
 * Debounced (250ms), cancellable search (Section 4). Syncs `?q=` to the URL,
 * surfaces recent searches (localStorage) + static trending terms, and groups
 * results (Titles now; People/Collections are labeled placeholders). Stale
 * responses are ignored via a monotonic request id. The actual query runs in a
 * server action through `useTransition` so no catalog logic ships to the client.
 */

const TRENDING = ['Aurora Drift', 'Sci-Fi', 'The Lantern District', 'Thriller', 'Emberfall', 'Drama'];
const RECENTS_KEY = 'lumora:recent-searches';
const MAX_RECENTS = 6;
const DEBOUNCE_MS = 250;

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function writeRecents(list: string[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch {
    /* storage unavailable (private mode / quota) — non-fatal */
  }
}

const chipClass =
  'inline-flex h-11 items-center rounded-md border border-border bg-surface-raised px-3 text-xs text-content transition-colors hover:border-border-strong hover:bg-surface-overlay focus-visible:outline-none';

export function SearchClient({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const pathname = usePathname();

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<Title[]>([]);
  const [activeQuery, setActiveQuery] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();

  const reqId = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Recents live in localStorage; hydrate after mount to avoid SSR mismatch.
  useEffect(() => {
    setRecents(readRecents());
  }, []);

  const runSearch = useCallback(
    (raw: string) => {
      const q = raw.trim();
      const id = ++reqId.current;
      if (!q) {
        setResults([]);
        setActiveQuery('');
        return;
      }
      startTransition(async () => {
        const found = await searchTitlesAction(q);
        // Ignore stale responses that resolved after a newer query started.
        if (id === reqId.current) {
          setResults(found);
          setActiveQuery(q);
        }
      });
    },
    [startTransition],
  );

  const syncUrl = useCallback(
    (raw: string) => {
      const q = raw.trim();
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const addRecent = useCallback((raw: string) => {
    const q = raw.trim();
    if (!q) return;
    setRecents((prev) => {
      const next = [q, ...prev.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENTS);
      writeRecents(next);
      return next;
    });
  }, []);

  // Run a deep-linked query once on mount; clean up the debounce on unmount.
  useEffect(() => {
    if (initialQuery.trim()) runSearch(initialQuery);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onInput = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runSearch(value);
      syncUrl(value);
    }, DEBOUNCE_MS);
  };

  const submitNow = (value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    runSearch(value);
    syncUrl(value);
    addRecent(value);
  };

  const pick = (term: string) => {
    setQuery(term);
    submitNow(term);
  };

  const clear = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    reqId.current += 1; // invalidate any in-flight request
    setQuery('');
    setResults([]);
    setActiveQuery('');
    syncUrl('');
  };

  const clearRecents = () => {
    setRecents([]);
    writeRecents([]);
  };

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;
  const settled = activeQuery === trimmed;
  const loading = hasQuery && (isPending || !settled);
  const showEmpty = hasQuery && settled && !isPending && results.length === 0;

  return (
    <div className="flex flex-col gap-8 pb-12">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submitNow(query);
        }}
      >
        <label htmlFor="site-search" className="sr-only">
          Search movies and shows
        </label>
        <div className="relative">
          <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-content-subtle">
            ⌕
          </span>
          <input
            id="site-search"
            type="search"
            value={query}
            onChange={(e) => onInput(e.target.value)}
            autoComplete="off"
            placeholder="Search movies and shows…"
            className="h-14 w-full rounded-lg border border-border bg-surface-raised pl-11 pr-12 text-base text-content shadow-soft transition-colors placeholder:text-content-subtle hover:border-border-strong focus:border-primary focus-visible:outline-none"
          />
          {query ? (
            <button
              type="button"
              onClick={clear}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-md text-content-subtle transition-colors hover:bg-surface-overlay hover:text-content"
            >
              <span aria-hidden="true" className="text-lg leading-none">
                ×
              </span>
            </button>
          ) : null}
        </div>
      </form>

      {!hasQuery ? (
        <div className="flex flex-col gap-6">
          {recents.length > 0 ? (
            <section aria-labelledby="recents-heading" className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-4">
                <h2 id="recents-heading" className="text-sm font-semibold text-content">
                  Recent searches
                </h2>
                <button type="button" onClick={clearRecents} className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
                  Clear
                </button>
              </div>
              <ul className="flex flex-wrap gap-2">
                {recents.map((term) => (
                  <li key={term}>
                    <button type="button" onClick={() => pick(term)} className={chipClass}>
                      {term}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="trending-heading" className="flex flex-col gap-3">
            <h2 id="trending-heading" className="text-sm font-semibold text-content">
              Trending searches
            </h2>
            <ul className="flex flex-wrap gap-2">
              {TRENDING.map((term) => (
                <li key={term}>
                  <button type="button" onClick={() => pick(term)} className={chipClass}>
                    {term}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : (
        <div className="flex flex-col gap-10">
          <section aria-labelledby="titles-heading" className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="titles-heading" className="text-lg font-semibold tracking-tight">
                Titles
              </h2>
              <p role="status" aria-live="polite" className="text-sm text-content-muted">
                {loading ? 'Searching…' : `${results.length} ${results.length === 1 ? 'result' : 'results'}`}
              </p>
            </div>

            {loading ? (
              <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {Array.from({ length: 6 }).map((_, i) => (
                  <li key={i} className="flex flex-col gap-2">
                    <Skeleton className="aspect-[2/3] w-full" />
                    <Skeleton className="h-3 w-20" />
                  </li>
                ))}
              </ul>
            ) : results.length > 0 ? (
              <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {results.map((title) => (
                  <li key={title.id}>
                    <MediaCard title={title} className="w-full sm:w-full md:w-full" />
                  </li>
                ))}
              </ul>
            ) : showEmpty ? (
              <EmptyState
                icon="✧"
                title={`No results for “${activeQuery}”`}
                description="Check the spelling, try fewer words, or browse by genre instead."
                action={
                  <Link href="/browse" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
                    Browse the catalog
                  </Link>
                }
              />
            ) : null}
          </section>

          <section aria-labelledby="people-heading" className="flex flex-col gap-3">
            <h2 id="people-heading" className="text-lg font-semibold tracking-tight">
              People
            </h2>
            <div className="rounded-md border border-dashed border-border bg-surface/40 px-4 py-6 text-sm text-content-muted">
              People search is coming soon.
            </div>
          </section>

          <section aria-labelledby="collections-heading" className="flex flex-col gap-3">
            <h2 id="collections-heading" className="text-lg font-semibold tracking-tight">
              Collections
            </h2>
            <div className="rounded-md border border-dashed border-border bg-surface/40 px-4 py-6 text-sm text-content-muted">
              Collection search is coming soon.
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
