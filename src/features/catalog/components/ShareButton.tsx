'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';

type CopyStatus = 'idle' | 'copied' | 'error';

/**
 * Copies the canonical title URL to the clipboard (Spec Section 4).
 * Prefers the async Clipboard API and falls back to a hidden textarea for
 * contexts where it is unavailable (e.g. non-secure origins). Result is
 * announced via an `aria-live` region.
 */
export function ShareButton({
  url,
  titleName,
  size = 'lg',
  className,
}: {
  url: string;
  titleName: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const flash = useCallback((next: Exclude<CopyStatus, 'idle'>) => {
    setStatus(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus('idle'), 2400);
  }, []);

  const onShare = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        flash('copied');
        return;
      }
      throw new Error('Clipboard API unavailable');
    } catch {
      flash(legacyCopy(url) ? 'copied' : 'error');
    }
  }, [url, flash]);

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onShare}
        aria-label={`Copy share link for ${titleName}`}
        className={cn(buttonClasses({ variant: 'ghost', size }), className)}
      >
        <span aria-hidden="true">↗</span>
        Share
      </button>
      <span
        role="status"
        aria-live="polite"
        className={cn(
          'text-xs',
          status === 'error' ? 'text-danger' : 'text-success',
          status === 'idle' && 'sr-only',
        )}
      >
        {status === 'copied'
          ? 'Link copied to clipboard'
          : status === 'error'
            ? `Couldn’t copy automatically — the link is ${url}`
            : ''}
      </span>
    </div>
  );
}

/** Legacy fallback for browsers without the async Clipboard API. */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
