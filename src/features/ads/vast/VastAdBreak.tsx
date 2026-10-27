'use client';

import { useEffect, useRef, useState } from 'react';
import type { PlaybackAdPolicy } from '@/features/commerce/types';
import type { VastCreative, VastTrackingEvent } from './types';
import { readConsent } from '@/components/consent/ConsentBanner';

export type VastBreakResult = 'complete' | 'skip' | 'error';

export function VastAdBreak({ creative, policy, volume = 1, muted = false, onDone }: {
  creative: VastCreative;
  policy: PlaybackAdPolicy;
  volume?: number;
  muted?: boolean;
  onDone: (result: VastBreakResult) => void;
}) {
  const video = useRef<HTMLVideoElement | null>(null);
  const done = useRef(false);
  const sent = useRef(new Set<VastTrackingEvent>());
  const callback = useRef(onDone);
  callback.current = onDone;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  const [needsPlay, setNeedsPlay] = useState(false);

  const track = (event: VastTrackingEvent) => {
    if (!readConsent()?.ads) return;
    if (sent.current.has(event)) return;
    sent.current.add(event);
    for (const target of creative.tracking[event] ?? []) {
      try {
        const url = new URL(target);
        if (url.protocol !== 'https:' || url.username || url.password) continue;
        const address = url.href.replace(/(?:\[CACHEBUSTING\]|%5BCACHEBUSTING%5D)/gi, String(Math.floor(10_000_000 + Math.random() * 90_000_000)))
          .replace(/(?:\[ERRORCODE\]|%5BERRORCODE%5D)/gi, '405');
        const image = new Image();
        image.referrerPolicy = 'no-referrer';
        image.src = address;
      } catch { /* Invalid tracking cannot interrupt playback. */ }
    }
  };
  const finish = (result: VastBreakResult) => {
    if (done.current) return;
    done.current = true;
    clearTimeout(timer.current);
    track(result);
    callback.current(result);
  };

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.volume = Math.max(0, Math.min(1, volume));
    element.muted = muted;
    timer.current = setTimeout(() => finish('error'), 15_000);
    void element.play().catch(() => { clearTimeout(timer.current); setNeedsPlay(true); });
    return () => { clearTimeout(timer.current); element.pause(); };
    // Each creative is mounted with a unique key; tracking and completion are break-local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skipAfter = policy.allowSkip && creative.skipAfterSeconds !== null
    ? Math.max(policy.skipAfterSeconds, creative.skipAfterSeconds) : Infinity;
  const remaining = Math.max(0, Math.ceil(creative.durationSeconds - elapsed));

  return <div className="lumora-vast-break" data-player-ui="" role="region" aria-label="Advertisement">
    <video ref={video} src={creative.mediaUrl} playsInline autoPlay muted={muted} disablePictureInPicture
      onPlaying={() => { clearTimeout(timer.current); setNeedsPlay(false); track('impression'); track('start'); }}
      onWaiting={() => { clearTimeout(timer.current); timer.current = setTimeout(() => finish('error'), 15_000); }}
      onEnded={() => finish('complete')} onError={() => finish('error')}
      onTimeUpdate={(event) => {
        const position = event.currentTarget.currentTime;
        setElapsed(position);
        if (position >= creative.durationSeconds * 0.25) track('firstQuartile');
        if (position >= creative.durationSeconds * 0.5) track('midpoint');
        if (position >= creative.durationSeconds * 0.75) track('thirdQuartile');
        if (position > 600) finish('error');
      }} />
    <div className="lumora-vast-label"><span>Advertisement</span><output aria-label="Advertisement remaining time">{remaining}s</output></div>
    {needsPlay ? <button className="lumora-vast-play" type="button" onClick={() => { void video.current?.play().catch(() => finish('error')); }}>Play advertisement</button> : null}
    <div className="lumora-vast-actions">
      {creative.clickThrough ? <a href={creative.clickThrough} target="_blank" rel="noopener noreferrer" onClick={() => {
        if (!readConsent()?.ads) return;
        for (const url of creative.clickTracking ?? []) { const image = new Image(); image.referrerPolicy = 'no-referrer'; image.src = url; }
      }}>Learn more</a> : null}
      {Number.isFinite(skipAfter) ? <button type="button" disabled={elapsed < skipAfter} onClick={() => finish('skip')}>{elapsed < skipAfter ? `Skip in ${Math.ceil(skipAfter - elapsed)}s` : 'Skip advertisement'}</button> : null}
    </div>
  </div>;
}
