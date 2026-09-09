'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';

/** Extract the YouTube video id from any common URL shape (`watch?v=`,
 *  `/embed/…`, `/shorts/…`, `youtu.be/…`). The catalog stores a mix. */
function youTubeKey(url: string): string | null {
  const m =
    /\/(?:embed|shorts)\/([A-Za-z0-9_-]{6,20})/.exec(url) ??
    /[?&]v=([A-Za-z0-9_-]{6,20})/.exec(url) ??
    /youtu\.be\/([A-Za-z0-9_-]{6,20})/.exec(url);
  return m?.[1] ?? null;
}

/**
 * Trailer modal (Spec Section 4): plays the official YouTube trailer in an
 * accessible dialog — Escape and overlay click close it, focus returns to the
 * trigger button, and the embed loads only when opened (no YouTube payload on
 * page load).
 */
export function TrailerButton({ trailerUrl, titleName }: { trailerUrl: string; titleName: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const key = youTubeKey(trailerUrl);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const trigger = triggerRef.current;
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      trigger?.focus();
    };
  }, [open]);

  return (
    <>
      <Button ref={triggerRef} variant="secondary" size="lg" onClick={() => setOpen(true)}>
        <span aria-hidden="true">▶</span> Trailer
      </Button>

      {open && key ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${titleName} trailer`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="flex w-full max-w-4xl flex-col gap-3">
            <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-black shadow-raised">
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${key}?autoplay=1&rel=0`}
                title={`${titleName} — official trailer`}
                className="absolute inset-0 h-full w-full border-0"
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
              />
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
