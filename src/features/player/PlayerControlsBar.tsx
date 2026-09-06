'use client';

import Link from 'next/link';
import { useId } from 'react';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';
import type { PlaybackSource } from '@/lib/providers/types';

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
  onReportIssue: () => void;
  reported?: boolean;
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
  onReportIssue,
  reported = false,
  className,
}: PlayerControlsBarProps) {
  const selectId = useId();
  const hasSources = sources.length > 0;

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
        <div className="flex items-center gap-2">
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
        </div>

        <button type="button" onClick={onReportIssue} className={buttonClasses({ variant: 'ghost' })}>
          <span aria-hidden="true">⚑</span> Report playback issue
        </button>

        {/* Acknowledgement is announced politely to assistive tech. */}
        <span role="status" aria-live="polite" className="text-xs text-success">
          {reported ? 'Thanks — your report was recorded.' : ''}
        </span>
      </div>
    </div>
  );
}
