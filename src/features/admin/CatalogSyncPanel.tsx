'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { SYNC_INITIAL_STATE, type SyncActionState } from './sync-state';
import { syncCatalogAction } from './sync-actions';

/**
 * One-click TMDB sync panel (Spec Sections 4, 7, 10).
 *
 * Two modes:
 *  - Charts: popular + top-rated movies/series.
 *  - Browse: TMDB discover with genre and year-range filters, deep pagination —
 *    so any slice of the catalog can be imported (e.g. all horror from the
 *    1980s), not just chart front pages.
 *
 * Imports titles with genuine TMDB/IMDb ids (playback resolution), posters,
 * backdrops, certifications, genres, and TV seasons. Idempotent: re-running
 * refreshes instead of duplicating. The action is permission-gated
 * (catalog.create) and runs entirely server-side; the API key never reaches
 * the browser.
 */
export function CatalogSyncPanel({ genreNames }: { genreNames: string[] }) {
  const [state, formAction, pending] = useActionState<SyncActionState, FormData>(
    syncCatalogAction,
    SYNC_INITIAL_STATE,
  );
  const [mode, setMode] = useState<'charts' | 'discover'>('charts');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-2xl flex-col gap-2">
        <h2 className="text-lg font-semibold text-content">TMDB catalog sync</h2>
        <p className="text-sm leading-relaxed text-content-muted">
          Imports real movies and series from TMDB into the catalog: titles with genuine TMDB/IMDb ids for playback
          resolution, posters and backdrops, certifications, genres, and TV season information. Re-running a sync
          refreshes existing titles instead of duplicating them. Users searching the catalog also auto-import TMDB
          matches, so the catalog grows with what people look for.
        </p>
      </div>

      <form action={formAction} className="flex max-w-2xl flex-col gap-4">
        <input type="hidden" name="source" value={mode} />

        {/* Mode */}
        <div role="group" aria-label="Sync mode" className="flex flex-wrap gap-2">
          {(
            [
              { key: 'charts', label: 'Charts (popular + top rated)' },
              { key: 'discover', label: 'Browse by genre & year' },
            ] as const
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={mode === option.key}
              onClick={() => setMode(option.key)}
              className={cn(
                'h-11 rounded-md border px-4 text-sm transition-colors duration-150 ease-deliberate',
                mode === option.key
                  ? 'border-border-strong bg-surface-overlay font-medium text-content'
                  : 'border-border bg-surface-raised/60 text-content-muted hover:text-content',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {/* Filters (discover mode) */}
        {mode === 'discover' ? (
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface/40 p-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-content">Type</span>
              <div className="flex flex-wrap gap-3 text-sm text-content-muted">
                {(['both', 'movie', 'tv'] as const).map((t) => (
                  <label key={t} className="flex items-center gap-1.5">
                    <input type="radio" name="type" value={t} defaultChecked={t === 'both'} className="accent-primary" />
                    {t === 'both' ? 'Movies + series' : t === 'movie' ? 'Movies only' : 'Series only'}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="sync-genre" className="text-sm font-medium text-content">
                Genre (optional)
              </label>
              <select
                id="sync-genre"
                name="genre"
                defaultValue=""
                className="h-11 max-w-xs rounded-md border border-border bg-surface-raised px-3 text-sm text-content focus-visible:outline-none focus-visible:border-primary"
              >
                <option value="">All genres</option>
                {genreNames.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-wrap gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="sync-year-from" className="text-sm font-medium text-content">
                  Year from (optional)
                </label>
                <input
                  id="sync-year-from"
                  name="yearFrom"
                  type="number"
                  min={1878}
                  max={2100}
                  placeholder="e.g. 1980"
                  className="h-11 w-40 rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="sync-year-to" className="text-sm font-medium text-content">
                  Year to (optional)
                </label>
                <input
                  id="sync-year-to"
                  name="yearTo"
                  type="number"
                  min={1878}
                  max={2100}
                  placeholder="e.g. 1989"
                  className="h-11 w-40 rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary"
                />
              </div>
            </div>
          </div>
        ) : null}

        {/* Size */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="sync-pages" className="text-sm font-medium text-content">
            How much to sync
          </label>
          <select
            id="sync-pages"
            name="pages"
            defaultValue="3"
            className="h-11 max-w-xs rounded-md border border-border bg-surface-raised px-3 text-sm text-content focus-visible:outline-none focus-visible:border-primary"
          >
            <option value="1">1 page — ~20–40 titles</option>
            <option value="3">3 pages — ~60–120 titles</option>
            <option value="10">10 pages — ~200–400 titles</option>
            <option value="25">25 pages — ~500–1000 titles (slower)</option>
            <option value="50">50 pages — ~1000–2000 titles (slowest)</option>
          </select>
          <p className="text-xs text-content-subtle">
            {mode === 'charts'
              ? 'Charts mode walks popular + top-rated lists per type.'
              : 'Browse mode walks TMDB discover with your filters — any genre or year range.'}
          </p>
        </div>

        <div>
          <Button type="submit" disabled={pending} size="lg">
            {pending ? 'Syncing from TMDB…' : 'Sync catalog now'}
          </Button>
        </div>

        {state.status === 'ok' ? (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-md border border-success/40 bg-success/10 px-4 py-3 text-sm text-success"
          >
            <span className="font-semibold">{state.message}</span>
            <span className="text-success/90">
              {state.seasons ?? 0} seasons · {state.genres ?? 0} genres
              {state.skipped ? ` · ${state.skipped} skipped (no synopsis/title)` : ''}
              {state.failed ? ` · ${state.failed} failed to fetch` : ''}
            </span>
          </div>
        ) : null}

        {state.status === 'error' ? (
          <p
            role="alert"
            className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger"
          >
            {state.message}
          </p>
        ) : null}
      </form>

      <p className="max-w-2xl text-xs leading-relaxed text-content-subtle">
        Metadata and artwork come from TMDB and are used under their terms with attribution. Only titles you are
        authorized to list are shown; playback resolution uses each title&apos;s public TMDB/IMDb id.
      </p>
    </div>
  );
}
