import { MediaCard } from './MediaCard';
import Link from 'next/link';
import type { ContinueWatchingEntry, MediaRow as MediaRowType } from '../types';
import { Container } from '@/components/ui/Container';
import { Icon } from '@/components/ui/Icon';

/**
 * Horizontally scrollable row of media cards. Cards are links and stay in the
 * tab order; the browser scrolls the container to the focused card.
 */
export function MediaRow({ row, variant = 'poster', number }: { row: MediaRowType; variant?: 'poster' | 'landscape'; number?: number }) {
  if (row.titles.length === 0) return null;
  return (
    <section aria-labelledby={`row-${row.id}`} className={`discovery-shelf ${variant === 'landscape' ? 'shelf-landscape' : 'shelf-poster'}`}>
      <Container className="shelf-heading">
        <div className="min-w-0">
          {number !== undefined ? <p className="site-eyebrow shelf-eyebrow">Collection {String(number).padStart(2, '0')}</p> : null}
          <h2 id={`row-${row.id}`} className="shelf-title">{row.heading}</h2>
          {row.reason ? <p className="shelf-description">{row.reason}</p> : null}
        </div>
        {row.href ? <Link href={row.href} prefetch={false} aria-label={`View all ${row.heading}`} className="shelf-view-all">View all <Icon name="arrow-right" width="18" height="18" /></Link> : null}
      </Container>
      <ul
        className="shelf-track"
        aria-label={`${row.heading} titles`}
      >
        {row.titles.map((title) => (
          <li key={title.id} className="shelf-item">
            <MediaCard title={title} variant={variant} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ContinueWatchingRow({ entries }: { entries: ContinueWatchingEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby="row-continue" className="discovery-shelf shelf-landscape">
      <Container className="shelf-heading">
        <h2 id="row-continue" className="shelf-title">
          Continue watching
        </h2>
      </Container>
      <ul className="shelf-track" aria-label="Continue watching titles">
        {entries.map((entry) => {
          // TV entries carry the exact episode to resume, so the card links
          // straight to /watch/tv/{slug}?season=N&episode=M and labels itself.
          const episodeHref = entry.episode
            ? `/watch/tv/${entry.title.slug}?season=${entry.episode.seasonNumber}&episode=${entry.episode.episodeNumber}`
            : undefined;
          return (
            <li key={entry.title.id} className="shelf-item">
              {entry.progress ? (
                /* Native playback recorded a real position — show the bar. */
                <div className="relative">
                  <MediaCard
                    title={entry.title}
                    progress={entry.progress.progress}
                    href={episodeHref}
                    variant="landscape"
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
                  <MediaCard title={entry.title} href={episodeHref} variant="landscape" />
                  <span className="media-card-continue-label">
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
