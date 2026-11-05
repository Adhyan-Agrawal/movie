'use client';

import { useEffect, useRef, useState } from 'react';
import { loadTrailer } from '@/features/trailers/client';
import { trailerLookupPath, type TrailerInfo, type TrailerLookup } from '@/features/trailers/types';
import styles from './TrailerPreview.module.css';

let activeStop: (() => void) | null = null;

type Preview = { trailer: TrailerInfo; path: string; id: number; isCurrent: () => boolean; stop: () => void };

function resetMedia(media: HTMLVideoElement | null) {
  if (!media) return;
  media.pause();
  media.removeAttribute('src');
  media.load();
}

export function TrailerPreview(props: TrailerLookup) {
  const element = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const sequence = useRef(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ready, setReady] = useState(false);
  const path = trailerLookupPath(props);
  const current = preview?.path === path ? preview : null;

  useEffect(() => {
    const card = element.current?.closest('a');
    if (!card || !path) return;
    let disposed = false;
    let hovering = false;
    let inView = true;
    let controller: AbortController | null = null;
    let delay: ReturnType<typeof setTimeout> | undefined;
    let stopAt: ReturnType<typeof setTimeout> | undefined;
    const pointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean; effectiveType?: string } }).connection;
    const eligible = () => !disposed && inView && document.visibilityState !== 'hidden' && !connection?.saveData
      && !/^(slow-)?2g$/.test(connection?.effectiveType ?? '') && pointer.matches && !motion.matches;
    const stop = () => {
      hovering = false;
      clearTimeout(delay); clearTimeout(stopAt);
      controller?.abort(); controller = null;
      resetMedia(video.current);
      if (!disposed) { setPreview(null); setReady(false); }
      if (activeStop === stop) activeStop = null;
    };
    const isCurrent = (request: AbortController) => !disposed && hovering && controller === request
      && !request.signal.aborted && activeStop === stop;
    const begin = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || !eligible()) return;
      activeStop?.(); activeStop = stop; hovering = true;
      delay = setTimeout(() => {
        if (disposed || !hovering || activeStop !== stop) return;
        if (!eligible()) { stop(); return; }
        controller = new AbortController();
        const request = controller;
        const id = ++sequence.current;
        const params = new URL(path, window.location.origin).searchParams;
        void loadTrailer({
          imdbId: params.get('imdbId') ?? undefined, tmdbId: params.get('tmdbId') ?? undefined,
          type: params.get('type') === 'tv' ? 'tv' : 'movie',
        }, request.signal).then((value) => {
          if (!isCurrent(request)) return;
          if (!value || !eligible()) { stop(); return; }
          setReady(false);
          setPreview({ trailer: value, path, id, isCurrent: () => isCurrent(request) && eligible(), stop });
          stopAt = setTimeout(stop, 30_000);
        }).catch(() => { if (isCurrent(request)) stop(); });
      }, 650);
    };
    const visibility = () => { if (document.visibilityState === 'hidden') stop(); };
    const preferences = () => { if (!eligible()) stop(); };
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
      const entry = entries.find((value) => value.target === card);
      if (!entry) return;
      inView = entry.isIntersecting && entry.intersectionRatio >= 0.25;
      if (!inView) stop();
    }, { threshold: 0.25 }) : null;
    observer?.observe(card);
    card.addEventListener('pointerenter', begin);
    card.addEventListener('pointerleave', stop);
    document.addEventListener('visibilitychange', visibility);
    pointer.addEventListener('change', preferences);
    motion.addEventListener('change', preferences);
    connection?.addEventListener?.('change', preferences);
    return () => {
      stop(); disposed = true;
      observer?.disconnect();
      card.removeEventListener('pointerenter', begin);
      card.removeEventListener('pointerleave', stop);
      document.removeEventListener('visibilitychange', visibility);
      pointer.removeEventListener('change', preferences);
      motion.removeEventListener('change', preferences);
      connection?.removeEventListener?.('change', preferences);
    };
  }, [path]);

  useEffect(() => {
    const media = video.current;
    if (!current || !media || !current.isCurrent()) return;
    let disposed = false;
    const valid = () => !disposed && current.isCurrent() && video.current === media;
    const failed = () => { if (valid()) current.stop(); };
    media.muted = true;
    media.playsInline = true;
    try {
      void media.play().then(() => { if (!valid()) resetMedia(media); }, failed);
    } catch { failed(); }
    // Refs are detached before passive unmount cleanup; retain this exact media node.
    return () => { disposed = true; resetMedia(media); };
  }, [current]);

  return <div ref={element} className={styles.preview} aria-hidden="true">
    {current ? <>
      <video key={current.id} ref={video} src={current.trailer.previewUrl} crossOrigin="anonymous" muted autoPlay playsInline loop preload="none"
        disablePictureInPicture disableRemotePlayback
        className={`${styles.video}${ready ? ` ${styles.ready}` : ''}`}
        onPlaying={(event) => { if (event.currentTarget === video.current && current.isCurrent() && !event.currentTarget.paused) setReady(true); }}
        onError={(event) => { if (event.currentTarget === video.current && current.isCurrent()) current.stop(); }} />
      {ready ? <span className={styles.label}>Trailer preview - Muted</span> : null}
    </> : null}
  </div>;
}
