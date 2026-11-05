'use client';

import { useEffect, useState } from 'react';
import { MediaCard } from './MediaCard';
import { readGuestEntries, type GuestWatchEntry } from '@/features/playback/guest-watch';
import { Container } from '@/components/ui/Container';
import Link from 'next/link';

/**
 * Guest (signed-out) continue watching (Spec Sections 4, 8): rendered from
 * THIS browser's localStorage, so each guest sees only their own history.
 * Loads after mount (localStorage is not available during SSR); renders
 * nothing when empty. Signed-in viewers get the server-side row instead — the
 * home page shows one or the other, never both.
 */
export function GuestContinueWatchingRow({ accountsAvailable = true }: { accountsAvailable?: boolean }) {
  const [entries, setEntries] = useState<GuestWatchEntry[]>([]);

  useEffect(() => {
    setEntries(readGuestEntries());
  }, []);

  if (entries.length === 0) return null;

  return (
    <section aria-labelledby="guest-continue-heading" className="discovery-shelf">
      <Container className="shelf-heading"><h2 id="guest-continue-heading" className="shelf-title">
        Continue watching
      </h2></Container>
      <ul className="shelf-track" aria-label="Continue watching on this device">
        {entries.slice(0, 12).map((entry) => {
          const episodeHref =
            entry.type === 'tv' && entry.seasonNumber !== undefined && entry.episodeNumber !== undefined
              ? `/watch/tv/${entry.slug}?season=${entry.seasonNumber}&episode=${entry.episodeNumber}`
              : undefined;
          return (
            <li key={`${entry.type}-${entry.slug}`} className="shelf-item">
              <MediaCard
                title={{
                  id: `guest-${entry.slug}`,
                  type: entry.type,
                  slug: entry.slug,
                  name: entry.name,
                  synopsis: '',
                  releaseYear: 0,
                  maturity: 'PG-13',
                  genres: [],
                  ...(entry.posterUrl ? { posterUrl: entry.posterUrl } : {}),
                }}
                progress={entry.progress}
                href={episodeHref}
                showMaturity={false}
              />
              {entry.seasonNumber !== undefined && entry.episodeNumber !== undefined ? (
                <p className="mt-1 truncate px-0.5 text-xs font-medium text-content-muted">
                  S{entry.seasonNumber} E{entry.episodeNumber}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Container><p className="text-xs leading-relaxed text-content-subtle">
        Saved on this device. {accountsAvailable ? <><Link href="/signin" prefetch={false} className="inline-flex min-h-11 items-center text-primary hover:underline">Sign in</Link> to sync your history everywhere.</>
          : 'Account synchronization is unavailable.'}
      </p></Container>
    </section>
  );
}
