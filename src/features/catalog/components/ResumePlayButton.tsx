'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { buttonClasses } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { readGuestEntries } from '@/features/playback/guest-watch';

/**
 * Play / Resume primary action (Spec Sections 4, 8).
 *
 * Turns the title page's primary button into "Resume" when the viewer has
 * already started the title, and for a SERIES deep-links to the LAST episode
 * they were watching instead of restarting:
 *   - Signed-in viewers: the server resolves the resume point from
 *     watch_progress (`serverResume` prop).
 *   - Guests: the resume point is read from THIS browser's guest store on
 *     mount (localStorage is not available during SSR).
 * When nothing is resumable it falls back to a plain Play button.
 */

export interface PlayResumeInfo {
  href: string;
  label: string;
  /** 0..1 progress fraction, shown as a subtle hint under the button. */
  progress?: number;
}

export function ResumePlayButton({
  baseHref,
  playable,
  signedIn,
  serverResume,
  className,
}: {
  /** e.g. `/watch/movie/{slug}` or `/watch/tv/{slug}` (movie default). */
  baseHref: string;
  /** When false the button renders disabled (no authorized source). */
  playable: boolean;
  signedIn: boolean;
  /** Server-resolved resume point for signed-in viewers, else null. */
  serverResume?: PlayResumeInfo | null;
  className?: string;
}) {
  const [guestResume, setGuestResume] = useState<PlayResumeInfo | null>(null);

  useEffect(() => {
    if (signedIn) {
      setGuestResume(null);
      return;
    }
    // Guest store entries carry season/episode for TV (see guest-watch.ts).
    const slug = baseHref.split('/').pop() ?? '';
    const entry = readGuestEntries().find((e) => e.slug === slug && (e.progress !== undefined || e.seasonNumber !== undefined));
    if (!entry) {
      setGuestResume(null);
      return;
    }
    const isTv = entry.type === 'tv';
    const hasEp = entry.seasonNumber !== undefined && entry.episodeNumber !== undefined;
    setGuestResume({
      href:
        isTv && hasEp
          ? `/watch/tv/${entry.slug}?season=${entry.seasonNumber}&episode=${entry.episodeNumber}`
          : baseHref,
      label:
        isTv && hasEp ? `Resume S${entry.seasonNumber} E${entry.episodeNumber}` : 'Resume',
      progress: entry.progress,
    });
  }, [signedIn, baseHref]);

  const resume = signedIn ? (serverResume ?? null) : guestResume;

  if (!playable) {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <button
          type="button"
          disabled
          aria-label="Play (unavailable)"
          className={buttonClasses({ size: 'lg', variant: 'primary' })}
        >
          <span aria-hidden="true">▶</span> Play
        </button>
        <span className="text-xs text-content-subtle">No authorized source available yet.</span>
      </div>
    );
  }

  const primaryHref = resume?.href ?? baseHref;
  const label = resume?.label ?? 'Play';

  return (
    <div className={cn('flex flex-col items-start gap-1', className)}>
      <Link
        href={primaryHref}
        aria-label={resume ? `Resume ${label}` : 'Play'}
        className={buttonClasses({ size: 'lg', variant: 'primary' })}
      >
        <span aria-hidden="true">{resume ? '↻' : '▶'}</span> {label}
      </Link>
      {resume?.progress != null && typeof resume.progress === 'number' ? (
        <span className="flex items-center gap-2 text-xs text-content-muted">
          <span className="h-1 w-24 overflow-hidden rounded bg-surface-raised">
            <span
              className="block h-full bg-primary"
              style={{ width: `${Math.round(Math.min(1, Math.max(0, resume.progress)) * 100)}%` }}
            />
          </span>
          Resumed
        </span>
      ) : null}
    </div>
  );
}
