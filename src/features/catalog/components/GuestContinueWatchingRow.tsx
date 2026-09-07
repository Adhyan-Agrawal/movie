'use client';

import { useEffect, useState } from 'react';
import { MediaCard } from './MediaCard';
import { readGuestEntries, type GuestWatchEntry } from '@/features/playback/guest-watch';

/**
 * Guest (signed-out) continue watching (Spec Sections 4, 8): rendered from
 * THIS browser's localStorage, so each guest sees only their own history.
 * Loads after mount (localStorage is not available during SSR); renders
 * nothing when empty. Signed-in viewers get the server-side row instead — the
 * home page shows one or the other, never both.
 */
export function GuestContinueWatchingRow() {
  const [entries, setEntries] = useState<GuestWatchEntry[]>([]);

  useEffect(() => {
    setEntries(readGuestEntries());
  }, []);

  if (entries.length === 0) return null;

  return (
    <section aria-labelledby="guest-continue-heading" className="flex flex-col gap-3">
      <h2 id="guest-continue-heading" className="text-lg font-semibold text-content">
        Continue watching
      </h2>
      <ul className="flex gap-4 overflow-x-auto pb-2">
        {entries.slice(0, 12).map((entry) => {
          const episodeHref =
            entry.type === 'tv' && entry.seasonNumber !== undefined && entry.episodeNumber !== undefined
              ? `/watch/tv/${entry.slug}?season=${entry.seasonNumber}&episode=${entry.episodeNumber}`
              : undefined;
          return (
            <li key={`${entry.type}-${entry.slug}`} className="w-36 shrink-0 sm:w-40">
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
      <p className="text-xs text-content-subtle">
        Saved on this device. <a href="/signin" className="text-primary hover:underline">Sign in</a> to sync your
        history everywhere.
      </p>
    </section>
  );
}
