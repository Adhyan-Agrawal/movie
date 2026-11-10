'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { loadTrailer } from '@/features/trailers/client';
import { trailerLookupPath, type TrailerInfo, type TrailerLookup } from '@/features/trailers/types';

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
export function TrailerButton({ trailerUrl, titleName, imdbId, tmdbId, type }: TrailerLookup & { trailerUrl?: string; titleName: string }) {
  const [open, setOpen] = useState(false);
  const [trailer, setTrailer] = useState<TrailerInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const key = trailerUrl ? youTubeKey(trailerUrl) : null;
  const path = trailerLookupPath({ imdbId, tmdbId, type });

  useEffect(() => {
    if (!open) return;
    let current = true;
    const controller = new AbortController();
    const trigger = triggerRef.current;
    dialogRef.current?.showModal();
    setTrailer(null);
    setLoading(Boolean(path));
    if (path) {
      void loadTrailer({ imdbId, tmdbId, type }, controller.signal).then((value) => {
        if (current) { setTrailer(value); setLoading(false); }
      });
    }
    return () => {
      current = false;
      controller.abort();
      trigger?.focus();
    };
  }, [open, path, imdbId, tmdbId, type]);

  return (
    <>
      <Button ref={triggerRef} variant="secondary" size="lg" onClick={() => {
        setTrailer(null);
        setLoading(Boolean(path));
        setOpen(true);
      }}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="m8 5 11 7-11 7z" /></svg> Trailer
      </Button>

      {open ? (
        <dialog
          ref={dialogRef}
          aria-label={`${titleName} trailer`}
          className="m-auto w-[calc(100%_-_2rem)] max-w-4xl rounded-lg border border-border bg-surface p-4 text-content backdrop:bg-black/80"
          onCancel={() => setOpen(false)}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (e.target === e.currentTarget && (e.clientX < rect.left || e.clientX > rect.right
              || e.clientY < rect.top || e.clientY > rect.bottom)) setOpen(false);
          }}
        >
          <div className="flex w-full flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-lg font-semibold">{titleName} trailer</h2>
              <Button variant="ghost" onClick={() => setOpen(false)} autoFocus>Close</Button>
            </div>
            <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-black shadow-raised">
              {loading ? <p role="status" className="flex h-full items-center justify-center text-sm text-content-muted">Finding trailer...</p>
                : trailer ? <video src={trailer.url} crossOrigin="anonymous" controls autoPlay playsInline preload="metadata" className="h-full w-full" onError={() => setTrailer(null)} />
                  : key ? <iframe
                src={`https://www.youtube-nocookie.com/embed/${key}?autoplay=1&rel=0`}
                title={`${titleName} trailer`}
                className="absolute inset-0 h-full w-full border-0"
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
              /> : <p role="status" className="flex h-full items-center justify-center px-4 text-center text-sm text-content-muted">Trailer unavailable. Please try again later.</p>}
            </div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
