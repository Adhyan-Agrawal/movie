import { MediaCard } from './MediaCard';
import type { ContinueWatchingEntry, MediaRow as MediaRowType } from '../types';

/**
 * Horizontally scrollable row of media cards. Cards are links and stay in the
 * tab order; the browser scrolls the container to the focused card.
 */
export function MediaRow({ row }: { row: MediaRowType }) {
  if (row.titles.length === 0) return null;
  return (
    <section aria-labelledby={`row-${row.id}`} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4 px-4 md:px-8">
        <h2 id={`row-${row.id}`} className="text-lg font-semibold tracking-tight">
          {row.heading}
        </h2>
        {row.reason ? <p className="text-xs text-content-subtle">{row.reason}</p> : null}
      </div>
      <ul
        className="flex gap-3 overflow-x-auto px-4 pb-2 md:px-8 [scrollbar-width:thin]"
        style={{ scrollSnapType: 'x proximity' }}
      >
        {row.titles.map((title) => (
          <li key={title.id} style={{ scrollSnapAlign: 'start' }}>
            <MediaCard title={title} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ContinueWatchingRow({ entries }: { entries: ContinueWatchingEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby="row-continue" className="flex flex-col gap-3">
      <div className="px-4 md:px-8">
        <h2 id="row-continue" className="text-lg font-semibold tracking-tight">
          Continue watching
        </h2>
      </div>
      <ul className="flex gap-3 overflow-x-auto px-4 pb-2 md:px-8 [scrollbar-width:thin]">
        {entries.map((entry) => {
          // TV entries carry the exact episode to resume, so the card links
          // straight to /watch/tv/{slug}?season=N&episode=M and labels itself.
          const episodeHref = entry.episode
            ? `/watch/tv/${entry.title.slug}?season=${entry.episode.seasonNumber}&episode=${entry.episode.episodeNumber}`
            : undefined;
          return (
            <li key={entry.title.id} style={{ scrollSnapAlign: 'start' }}>
              {entry.progress ? (
                /* Native playback recorded a real position — show the bar. */
                <div className="relative">
                  <MediaCard
                    title={entry.title}
                    progress={entry.progress.progress}
                    href={episodeHref}
                  />
                  <span className="sr-only">
                    {Math.round(entry.progress.progress * 100)}% watched — resume {entry.title.name}
                    {episodeHref ? ` at episode ${entry.episode!.episodeNumber}` : ''}
                  </span>
                </div>
              ) : (
                /* Watched via an external server, which shares no position: an
                   honest "Continue" badge instead of a fabricated progress bar. */
                <div className="relative">
                  <MediaCard title={entry.title} href={episodeHref} />
                  <span className="absolute left-2 top-9 rounded bg-surface/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-content shadow-soft">
                    Continue
                  </span>
                  <span className="sr-only">Continue {entry.title.name} — position unknown</span>
                </div>
              )}
              {entry.episode ? (
                <p className="mt-1 truncate px-0.5 text-xs font-medium text-content-muted" title={entry.episode.name}>
                  S{entry.episode.seasonNumber} E{entry.episode.episodeNumber}
                  {entry.episode.name ? ` · ${entry.episode.name}` : ''}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
