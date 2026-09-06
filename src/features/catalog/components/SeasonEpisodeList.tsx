'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';
import { formatEpisodeCode, formatRuntime, type SynthSeason } from './title-detail-helpers';

/**
 * Accessible season selector + episode list (Spec Section 4).
 * Seasons are synthesized server-side and passed in as serializable props; this
 * client component only owns the "which season is shown" interaction.
 */
export function SeasonEpisodeList({
  seasons,
  titleType,
  titleSlug,
  titleName,
}: {
  seasons: SynthSeason[];
  titleType: string;
  titleSlug: string;
  titleName: string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();

  if (seasons.length === 0) return null;
  const active = seasons[activeIndex] ?? seasons[0];
  if (!active) return null;

  return (
    <div className="flex flex-col gap-4">
      {seasons.length > 1 ? (
        <div role="group" aria-label="Select season" className="flex flex-wrap gap-2">
          {seasons.map((season, index) => {
            const selected = index === activeIndex;
            return (
              <button
                key={season.seasonNumber}
                type="button"
                aria-pressed={selected}
                onClick={() => setActiveIndex(index)}
                className={cn(
                  'h-9 rounded-md border px-3 text-sm transition-colors duration-150 ease-deliberate',
                  selected
                    ? 'border-border-strong bg-surface-overlay text-content'
                    : 'border-border bg-surface-raised/60 text-content-muted hover:text-content',
                )}
              >
                {season.name}
              </button>
            );
          })}
        </div>
      ) : null}

      <p id={listId} className="sr-only">{`Episodes — ${active.name} of ${titleName}`}</p>

      <ol
        aria-labelledby={listId}
        className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface/40"
      >
        {active.episodes.map((ep) => {
          const code = formatEpisodeCode(ep.seasonNumber, ep.episodeNumber);
          const runtime = formatRuntime(ep.runtimeMinutes);
          return (
            <li key={ep.episodeNumber} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:gap-4">
              <div className="shrink-0 pt-0.5 text-sm font-semibold tabular-nums text-content-subtle sm:w-14">
                {code}
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="text-sm font-semibold text-content">{ep.name}</h3>
                  {runtime ? <span className="text-xs text-content-muted">{runtime}</span> : null}
                </div>
                <p className="text-sm leading-relaxed text-content-muted">{ep.synopsis}</p>
              </div>
              <div className="shrink-0">
                <Link
                  href={`/watch/${titleType}/${titleSlug}?season=${ep.seasonNumber}&episode=${ep.episodeNumber}`}
                  className={buttonClasses({ variant: 'secondary', size: 'sm' })}
                  aria-label={`Play ${titleName} ${code}: ${ep.name}`}
                >
                  <span aria-hidden="true">▶</span> Play
                </Link>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
