'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';
import { formatRuntime } from './title-detail-helpers';
import type { Episode, Season } from '../types';

/**
 * Season selector + episode list for TV title detail (recreated SeasonEpisodeList).
 *
 * Seasons come from the `seasons` table and episode rows from `episodes` — when
 * a season's episodes haven't been imported yet, only the season's real
 * episode count is shown (never a fabricated episode list). Each imported
 * episode links to the watch route with `?season=N&episode=M`, which the watch
 * page resolves into the playback request.
 *
 * Accessibility: the season strip is a WAI-ARIA tabs pattern (role=tablist with
 * arrow/Home/End key support, aria-selected, and a labelled tabpanel) so
 * screen-reader and keyboard users get the same season switching.
 */

function formatAirDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function EpisodeRow({ episode, watchBaseHref }: { episode: Episode; watchBaseHref: string }) {
  const runtime = formatRuntime(episode.runtimeMinutes ?? undefined);
  const aired = formatAirDate(episode.airDate);
  const href = `${watchBaseHref}?season=${episode.seasonNumber}&episode=${episode.episodeNumber}`;

  return (
    <li className="flex gap-4 rounded-md border border-border bg-surface/40 p-3 transition-colors hover:border-border-strong">
      {/* Episode still (decorative — the row text carries the meaning) */}
      <div
        aria-hidden="true"
        className="relative hidden h-16 w-28 shrink-0 overflow-hidden rounded bg-surface-raised sm:block"
      >
        {episode.stillUrl ? (
          <Image src={episode.stillUrl} alt="" fill sizes="112px" className="object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-content-subtle">▦</div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-semibold text-content">
            E{episode.episodeNumber} · {episode.name}
          </span>
          {runtime ? (
            <span className="text-xs text-content-muted" aria-label={`Runtime ${runtime}`}>
              {runtime}
            </span>
          ) : null}
          {aired ? (
            <span className="text-xs text-content-muted" aria-label={`Aired ${aired}`}>
              {aired}
            </span>
          ) : null}
        </div>
        {episode.overview ? (
          <p className="line-clamp-3 text-sm leading-relaxed text-content-muted">{episode.overview}</p>
        ) : null}
        <div className="mt-1">
          <Link
            href={href}
            className={buttonClasses({ size: 'sm', variant: 'secondary' })}
            aria-label={`Play episode ${episode.episodeNumber}, ${episode.name}`}
          >
            <span aria-hidden="true">▶</span> Play
          </Link>
        </div>
      </div>
    </li>
  );
}

export function SeasonEpisodeList({
  seasons,
  titleSlug,
  titleName,
}: {
  seasons: Season[];
  titleSlug: string;
  titleName: string;
}) {
  // Default to the first season that has imported episode rows (so the section
  // leads with real detail), falling back to the first season.
  const firstWithEpisodes = seasons.findIndex((s) => s.episodes.length > 0);
  const [selected, setSelected] = useState(firstWithEpisodes >= 0 ? firstWithEpisodes : 0);
  const season = seasons[selected];
  if (!season) return null;

  const watchBaseHref = `/watch/tv/${titleSlug}`;
  const selectNext = (dir: 1 | -1) => {
    setSelected((prev) => Math.min(seasons.length - 1, Math.max(0, prev + dir)));
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label={`Seasons of ${titleName}`}
        className="flex flex-wrap gap-2"
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            selectNext(e.key === 'ArrowRight' ? 1 : -1);
          } else if (e.key === 'Home') {
            e.preventDefault();
            setSelected(0);
          } else if (e.key === 'End') {
            e.preventDefault();
            setSelected(seasons.length - 1);
          }
        }}
      >
        {seasons.map((s, i) => {
          const label = s.name ?? `Season ${s.seasonNumber}`;
          const active = i === selected;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              id={`season-tab-${s.id}`}
              aria-selected={active}
              aria-controls={`season-panel-${s.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setSelected(i)}
              className={cn(
                'h-9 rounded-md border px-3 text-sm transition-colors focus-visible:outline-none',
                'focus-visible:ring-2 focus-visible:ring-primary',
                active
                  ? 'border-primary bg-primary text-primary-contrast font-semibold'
                  : 'border-border bg-surface-raised text-content-muted hover:text-content',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`season-panel-${season.id}`}
        aria-labelledby={`season-tab-${season.id}`}
        className="flex flex-col gap-4"
      >
        {season.overview ? (
          <p className="text-sm leading-relaxed text-content-muted">{season.overview}</p>
        ) : null}

        {season.episodes.length > 0 ? (
          <ol className="flex flex-col gap-3">
            {season.episodes.map((ep) => (
              <EpisodeRow key={ep.id} episode={ep} watchBaseHref={watchBaseHref} />
            ))}
          </ol>
        ) : (
          /* Honest state: the season row exists but its episodes weren't
             imported — show the real count, never invented detail. */
          <p className="rounded-md border border-dashed border-border bg-surface/40 px-4 py-6 text-center text-sm text-content-muted">
            {season.episodeCount != null
              ? `${season.episodeCount} episode${season.episodeCount === 1 ? '' : 's'} in ${
                  season.name ?? `Season ${season.seasonNumber}`
                } — per-episode details haven’t been imported yet.`
              : 'Per-episode details haven’t been imported for this season yet.'}
          </p>
        )}
      </div>
    </div>
  );
}
