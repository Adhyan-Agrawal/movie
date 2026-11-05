'use client';

import Link from 'next/link';
import { useId } from 'react';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';
import type { PlaybackSource } from '@/lib/providers/types';
import type { EpisodeNavigation } from './episode-navigation';

export interface EpisodeNavigationControls extends EpisodeNavigation {
  disabled?: boolean;
  pending?: boolean;
  onNavigate: (direction: 'previous' | 'next') => boolean;
}

/**
 * Player controls bar (Spec Section 9): back navigation, source/server selector,
 * and a report-issue action. Fully keyboard operable — native <button>, <a>,
 * and <select> with visible focus (global) and 44px-minimum targets.
 *
 * Presentational + controlled: all state lives in the parent PlayerShell.
 */
export interface PlayerControlsBarProps {
  backHref: string;
  backLabel: string;
  sources: PlaybackSource[];
  selectedSourceId: string | null;
  onSelectSource: (id: string) => void;
  showSourceSelector?: boolean;
  onReportIssue: () => void;
  reported?: boolean;
  reportingAvailable?: boolean;
  reportPending?: boolean;
  reportError?: string;
  watchParty?: {
    available: boolean;
    active: boolean;
    participantCount: number;
    onOpen: () => void;
  };
  episodeNavigation?: EpisodeNavigationControls;
  className?: string;
}

const controlSurface =
  'inline-flex h-11 items-center rounded-md border border-border-strong bg-surface-raised px-3 text-sm ' +
  'text-content transition-colors hover:bg-surface-overlay focus-visible:outline-none disabled:opacity-50 ' +
  'disabled:cursor-not-allowed';

export function PlayerControlsBar({
  backHref,
  backLabel,
  sources,
  selectedSourceId,
  onSelectSource,
  showSourceSelector = true,
  onReportIssue,
  reported = false,
  reportingAvailable = false,
  reportPending = false,
  reportError,
  watchParty,
  episodeNavigation,
  className,
}: PlayerControlsBarProps) {
  const selectId = useId();
  const hasSources = sources.length > 0;
  const reportDisabled = !reportingAvailable || reportPending || reported;

  return (
    <div
      className={cn('flex flex-wrap items-center justify-between gap-3', className)}
      role="group"
      aria-label="Player controls"
    >
      <Link href={backHref} aria-label={backLabel} className={buttonClasses({ variant: 'secondary' })}>
        <span aria-hidden="true">←</span> Back
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        {episodeNavigation ? <EpisodeControls {...episodeNavigation} /> : null}
        {showSourceSelector ? <div className="flex items-center gap-2">
          <label htmlFor={selectId} className="text-xs font-medium text-content-muted">
            Source
          </label>
          {/* Alternate authorized source selection (Spec Section 9). One source
              today; the control is present so switching is available the moment
              additional authorized providers are configured. */}
          <select
            id={selectId}
            value={selectedSourceId ?? ''}
            onChange={(event) => onSelectSource(event.target.value)}
            disabled={!hasSources}
            className={cn(controlSurface, 'pr-8')}
          >
            {hasSources ? (
              sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))
            ) : (
              <option value="">No alternate sources</option>
            )}
          </select>
        </div> : null}

        {watchParty ? (
          <button
            type="button"
            onClick={() => { if (watchParty.available) watchParty.onOpen(); }}
            disabled={!watchParty.available}
            aria-haspopup="dialog"
            className={buttonClasses({ variant: watchParty.active ? 'secondary' : 'primary' })}
          >
            {!watchParty.available ? 'Watch Party unavailable' : watchParty.active
              ? `Party chat (${watchParty.participantCount})`
              : 'Invite / Join party'}
          </button>
        ) : null}

        <button type="button" disabled={reportDisabled} aria-busy={reportPending}
          onClick={() => { if (!reportDisabled) onReportIssue(); }} className={buttonClasses({ variant: 'ghost' })}>
          <span aria-hidden="true">⚑</span> Report playback issue
        </button>

        {/* Acknowledgement is announced politely to assistive tech. */}
        <span role="status" aria-live="polite" className={cn('text-xs', reported ? 'text-success' : reportError ? 'text-danger' : 'text-content-muted')}>
          {!reportingAvailable ? 'Reporting unavailable' : reportPending ? 'Sending report...' : reported
            ? 'Thanks, your report was recorded.' : reportError ?? ''}
        </span>
      </div>
    </div>
  );
}

export function EpisodeControls({ previous, next, disabled, pending, onNavigate }: EpisodeNavigationControls) {
  return <div role="group" aria-label="Episode controls" className="flex flex-wrap items-center gap-2">
    {(['previous', 'next'] as const).map((direction) => {
      const target = direction === 'previous' ? previous : next;
      const label = direction === 'previous' ? 'Previous' : 'Next';
      return <button key={direction} type="button" className={cn(controlSurface, 'min-h-11 min-w-11 gap-2')}
        aria-label={`${label} episode${target ? ` (S${target.seasonNumber} E${target.episodeNumber})` : ''}`}
        title={target?.name || undefined} disabled={!target || disabled || pending} aria-busy={pending}
        onClick={() => { if (target && !disabled && !pending) onNavigate(direction); }}>
        {direction === 'previous' ? <span aria-hidden="true">&lt;</span> : null}{label}
        {direction === 'next' ? <span aria-hidden="true">&gt;</span> : null}
      </button>;
    })}
    {disabled ? <span className="text-xs text-content-muted">Episode navigation is unavailable in a watch party.</span> : null}
  </div>;
}
