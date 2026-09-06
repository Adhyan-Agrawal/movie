'use client';

import { useCallback, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';
import type { MaturityRating, TitleType } from '@/features/catalog/types';

/**
 * Crafted filter + sort controls for the browse surfaces (Section 4). All state
 * is serialized to the URL query string (source of truth) via `router.replace`
 * with `{ scroll: false }` — no full reload. Active filters render as removable
 * chips; "Reset all" clears everything. Native selects are styled with the
 * token palette (Linear/Stripe feel), each wrapped in a visible <label>.
 */

const SORT_OPTIONS = [
  { value: 'trending', label: 'Trending' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'az', label: 'A–Z' },
  { value: 'score', label: 'Top rated' },
] as const;

const MATURITY_OPTIONS: readonly MaturityRating[] = [
  'G',
  'PG',
  'PG-13',
  'R',
  'NC-17',
  'TV-MA',
  'TV-14',
  'TV-PG',
];

const DECADE_OPTIONS: readonly number[] = (() => {
  const out: number[] = [];
  for (let d = 2020; d >= 1970; d -= 10) out.push(d);
  return out;
})();

function sortLabelOf(value: string): string {
  const found = SORT_OPTIONS.find((o) => o.value === value);
  return found ? found.label : value;
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-[8.5rem] flex-1 flex-col gap-1.5 sm:flex-none">
      <span className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">{label}</span>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-full appearance-none rounded-md border border-border bg-surface-raised pl-3 pr-9 text-sm text-content shadow-soft transition-colors hover:border-border-strong focus:border-primary focus-visible:outline-none"
        >
          {children}
        </select>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-content-subtle"
        >
          ▾
        </span>
      </div>
    </label>
  );
}

export function FilterBar({
  genres,
  lockType,
  lockGenre,
}: {
  genres: string[];
  /** When set, the route already scopes to this type — the Type control hides. */
  lockType?: TitleType;
  /** When set, the route already scopes to this genre — the Genre control hides. */
  lockGenre?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const commit = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      // Any filter change returns to the first page.
      params.delete('page');
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const onType = (v: string) => commit((p) => (v ? p.set('type', v) : p.delete('type')));
  const onGenre = (v: string) => commit((p) => (v ? p.set('genre', v) : p.delete('genre')));
  const onDecade = (v: string) =>
    commit((p) => {
      if (v) {
        p.set('minYear', v);
        p.set('maxYear', String(Number(v) + 9));
      } else {
        p.delete('minYear');
        p.delete('maxYear');
      }
    });
  const onMaturity = (v: string) => commit((p) => (v ? p.set('maturity', v) : p.delete('maturity')));
  const onSort = (v: string) => commit((p) => (v && v !== 'trending' ? p.set('sort', v) : p.delete('sort')));
  const reset = () => router.replace(pathname, { scroll: false });

  // Controlled values read back from the URL.
  const rawType = searchParams.get('type');
  const typeValue = rawType === 'movie' || rawType === 'tv' ? rawType : '';
  const genreValue = searchParams.get('genre') ?? '';
  const minYearNum = Number.parseInt(searchParams.get('minYear') ?? '', 10);
  const decadeValue = Number.isFinite(minYearNum) ? String(Math.floor(minYearNum / 10) * 10) : '';
  const maturityValue = searchParams.get('maturity') ?? '';
  const sortValue = searchParams.get('sort') ?? 'trending';
  const qValue = searchParams.get('q') ?? '';

  const chips: { key: string; label: string; onRemove: () => void }[] = [];
  if (!lockType && typeValue)
    chips.push({ key: 'type', label: typeValue === 'movie' ? 'Movies' : 'Series', onRemove: () => onType('') });
  if (!lockGenre && genreValue) chips.push({ key: 'genre', label: genreValue, onRemove: () => onGenre('') });
  if (decadeValue) chips.push({ key: 'decade', label: `${decadeValue}s`, onRemove: () => onDecade('') });
  if (maturityValue) chips.push({ key: 'maturity', label: maturityValue, onRemove: () => onMaturity('') });
  if (sortValue !== 'trending')
    chips.push({ key: 'sort', label: `Sort: ${sortLabelOf(sortValue)}`, onRemove: () => onSort('trending') });
  if (qValue) chips.push({ key: 'q', label: `“${qValue}”`, onRemove: () => commit((p) => p.delete('q')) });

  return (
    <section
      aria-label="Filter and sort titles"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface/50 p-3 shadow-soft md:p-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        {!lockType ? (
          <FilterSelect label="Type" value={typeValue} onChange={onType}>
            <option value="">All types</option>
            <option value="movie">Movies</option>
            <option value="tv">TV</option>
          </FilterSelect>
        ) : null}

        {!lockGenre ? (
          <FilterSelect label="Genre" value={genreValue} onChange={onGenre}>
            <option value="">All genres</option>
            {genres.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </FilterSelect>
        ) : null}

        <FilterSelect label="Decade" value={decadeValue} onChange={onDecade}>
          <option value="">Any decade</option>
          {DECADE_OPTIONS.map((d) => (
            <option key={d} value={String(d)}>
              {d}s
            </option>
          ))}
        </FilterSelect>

        <FilterSelect label="Maturity" value={maturityValue} onChange={onMaturity}>
          <option value="">All ratings</option>
          {MATURITY_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </FilterSelect>

        <FilterSelect label="Sort" value={sortValue} onChange={onSort}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </FilterSelect>
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">Active</span>
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={c.onRemove}
              aria-label={`Remove ${c.label} filter`}
              className="group inline-flex h-11 items-center gap-1.5 rounded-md border border-border bg-surface-raised pl-3 pr-2.5 text-xs text-content transition-colors hover:border-border-strong hover:bg-surface-overlay"
            >
              <span>{c.label}</span>
              <span
                aria-hidden="true"
                className="text-sm leading-none text-content-subtle transition-colors group-hover:text-content"
              >
                ×
              </span>
            </button>
          ))}
          <button type="button" onClick={reset} className={cn(buttonClasses({ variant: 'ghost', size: 'sm' }), 'ml-auto')}>
            Reset all
          </button>
        </div>
      ) : null}
    </section>
  );
}
