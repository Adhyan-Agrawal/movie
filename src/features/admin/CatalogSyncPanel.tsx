'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { SYNC_INITIAL_STATE, type SyncActionState } from './sync-state';
import { syncCatalogAction } from './sync-actions';

/**
 * One-click TMDB sync panel (Spec Sections 4, 7, 10). Syncs popular +
 * top-rated movies and series into the live catalog — real TMDB ids, posters,
 * certifications, genres, and TV seasons. Idempotent: re-running refreshes.
 *
 * The action is permission-gated (catalog.create) and runs entirely
 * server-side; the API key never reaches the browser.
 */
export function CatalogSyncPanel() {
  const [state, formAction, pending] = useActionState<SyncActionState, FormData>(
    syncCatalogAction,
    SYNC_INITIAL_STATE,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-2xl flex-col gap-2">
        <h2 className="text-lg font-semibold text-content">TMDB catalog sync</h2>
        <p className="text-sm leading-relaxed text-content-muted">
          Imports real movies and series from TMDB (popular + top-rated lists) into the catalog: titles with genuine
          TMDB/IMDb ids for playback resolution, posters and backdrops, certifications, genres, and TV season
          information. Re-running a sync refreshes existing titles instead of duplicating them.
        </p>
      </div>

      <form action={formAction} className="flex max-w-2xl flex-col gap-4">
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
            <option value="1">Quick — ~80 titles</option>
            <option value="3">Standard — ~240 titles</option>
            <option value="5">Large — ~400 titles</option>
            <option value="10">Maximum — ~800 titles (slower)</option>
          </select>
          <p className="text-xs text-content-subtle">Each step covers popular + top-rated, movies and series.</p>
        </div>

        <div>
          <Button type="submit" disabled={pending} size="lg">
            {pending ? 'Syncing from TMDB…' : 'Sync catalog now'}
          </Button>
        </div>

        {state.status === 'ok' ? (
          <div role="status" className="flex flex-col gap-1 rounded-md border border-success/40 bg-success/10 px-4 py-3 text-sm text-success">
            <span className="font-semibold">{state.message}</span>
            <span className="text-success/90">
              {state.seasons ?? 0} seasons · {state.genres ?? 0} genres
              {state.skipped ? ` · ${state.skipped} skipped (no synopsis/title)` : ''}
              {state.failed ? ` · ${state.failed} failed to fetch` : ''}
            </span>
          </div>
        ) : null}

        {state.status === 'error' ? (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger">
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
