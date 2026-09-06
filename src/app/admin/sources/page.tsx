import Link from 'next/link';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { listSeasonsForTitle } from '@/features/catalog/queries';
import { SourcesManager, type SourcesEpisodeOption } from '@/features/admin/SourcesManager';
import { getAdminTitleById, listAdminTitles, listMediaSourcesForTitle } from '@/features/admin/queries';

export const metadata = {
  title: 'Media',
  description: 'Upload videos to private storage and manage stream sources per title.',
};

/**
 * Admin media upload + source management (Spec Sections 7, 9, 11).
 *
 * Two states, driven entirely by URL params (no client JS needed to navigate):
 *  - `?q=` — search the catalog to pick a title (movies and series alike).
 *  - `?titleId=` — the sources console for that one title: existing sources,
 *    the direct-to-private-storage upload form, and the remote-stream form.
 * All mutations happen through permission-gated server actions
 * (`provider.manage`, matching the `media_sources_manage` RLS policy).
 */

/** Titles shown per search result page. */
const RESULT_LIMIT = 25;

/** Next 15 resolves `searchParams` to this shape. */
type SearchParamsRecord = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminSourcesPage({ searchParams }: { searchParams: Promise<SearchParamsRecord> }) {
  const sp = await searchParams;

  const q = firstParam(sp.q)?.trim() ?? '';
  const titleId = firstParam(sp.titleId)?.trim() ?? '';

  // -------------------------------------------------------------------------
  // Title picker (no titleId yet)
  // -------------------------------------------------------------------------
  if (!titleId) {
    const { rows, total } = await listAdminTitles({ query: q || undefined, pageSize: RESULT_LIMIT });

    return (
      <div className="flex flex-col gap-6 py-6">
        <PageHeader
          title="Media"
          description="Upload videos to Lumora's private storage and manage playback sources. Pick a title first — uploads and remote streams always belong to a movie or an episode of a series."
        />

        <section
          aria-label="Search titles"
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface/50 p-3 shadow-soft md:p-4"
        >
          <form method="get" action="/admin/sources" role="search" className="flex flex-wrap items-end gap-3">
            <label htmlFor="sources-title-search" className="flex w-full flex-col gap-1.5 sm:max-w-md">
              <span className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">Search</span>
              <input
                id="sources-title-search"
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Search titles by name…"
                className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-sm text-content shadow-soft transition-colors hover:border-border-strong focus:border-primary focus-visible:outline-none"
              />
            </label>
            <button type="submit" className={buttonClasses({ variant: 'primary' })}>
              Search
            </button>
          </form>
        </section>

        {rows.length === 0 ? (
          <EmptyState
            icon="⇈"
            title={q ? `No titles match “${q}”` : 'Search for a title to manage its media'}
            description={
              q
                ? 'Try a different search term, or clear the search to browse the catalog.'
                : 'Media sources live on a title (movies) or an episode (series). Search above to pick one.'
            }
          />
        ) : (
          <>
            <p className="text-sm text-content-muted" aria-live="polite">
              {`Showing ${rows.length.toLocaleString()} of ${total.toLocaleString()} titles`}
              {q ? ` matching “${q}”` : ''}
              {total > rows.length ? ' — refine the search to narrow it down.' : ''}
            </p>
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface/50 shadow-soft">
              {rows.map((title) => (
                <li key={title.id}>
                  <Link
                    href={`/admin/sources?titleId=${title.id}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
                    className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 text-sm transition-colors hover:bg-surface-raised/60"
                  >
                    <span className="font-medium text-content">
                      {title.name}
                      <span className="ml-2 text-xs uppercase tracking-wide text-content-subtle">{title.type}</span>
                    </span>
                    <span className="text-xs text-content-muted tabular-nums">
                      {title.releaseYear || '—'} · Manage media →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Sources console for one title
  // -------------------------------------------------------------------------
  const title = await getAdminTitleById(titleId);
  if (!title) {
    return (
      <div className="py-6">
        <PageHeader title="Media" description="Uploads, storage, and stream sources." />
        <EmptyState
          icon="⇈"
          title="Title not found"
          description="This title id doesn't match anything in the catalog (it may have been deleted)."
          action={
            <Link href="/admin/sources" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              ← Back to title search
            </Link>
          }
        />
      </div>
    );
  }

  // Episodes (series only in practice — movies simply have none).
  const seasons = await listSeasonsForTitle(title.id);
  const episodes: SourcesEpisodeOption[] = seasons.flatMap((season) =>
    (season.episodes ?? []).map((episode) => ({
      id: episode.id,
      label: `S${season.seasonNumber} · E${episode.episodeNumber} · ${episode.name}`,
    })),
  );

  const sources = await listMediaSourcesForTitle(title.id);

  return (
    <div className="flex flex-col gap-6 py-6">
      <PageHeader
        title="Media"
        description="Uploads, storage, and stream sources — files go straight to private storage; playback resolves server-side via time-limited signed URLs."
        actions={
          <Link href={`/admin/sources${q ? `?q=${encodeURIComponent(q)}` : ''}`} className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
            ← Pick a different title
          </Link>
        }
      />

      <header className="flex flex-col gap-1 rounded-lg border border-border bg-surface/50 p-4 shadow-soft">
        <h2 className="font-display text-xl font-bold tracking-tight">{title.name}</h2>
        <p className="text-sm text-content-muted">
          <span className="uppercase tracking-wide">{title.type}</span>
          {title.releaseYear ? ` · ${title.releaseYear}` : ''}
          {title.type === 'tv' && episodes.length > 0 ? ` · ${episodes.length} episodes` : ''}
        </p>
      </header>

      <SourcesManager
        title={{ id: title.id, name: title.name, type: title.type, releaseYear: title.releaseYear }}
        episodes={episodes}
        sources={sources}
      />
    </div>
  );
}
