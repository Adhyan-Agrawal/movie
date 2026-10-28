'use client';

import { useEffect, useRef, useState } from 'react';
import type { PlaybackAdPolicy } from '@/features/commerce/types';
import type { VastCreative, VastTrackingEvent } from './types';
import { readConsent } from '@/components/consent/ConsentBanner';

export type VastBreakResult = 'complete' | 'skip' | 'error';

export interface VastAdBreakProps {
  creative: VastCreative;
  policy: PlaybackAdPolicy;
  volume?: number;
  muted?: boolean;
  consent?: boolean;
  onDone: (result: VastBreakResult) => void;
  onSkip?: () => void;
  onError?: (error: Error) => void;
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443')
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
      && !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(url.hostname)
      && !url.hostname.endsWith('.home.arpa') ? url.href : undefined;
  } catch { return undefined; }
}

/** Mount with a break-specific key. Content video and checkpoints remain parent-owned. */
export function VastAdBreak(props: VastAdBreakProps) {
  const { creative, policy, volume = 1, muted = false } = props;
  const video = useRef<HTMLVideoElement | null>(null);
  const done = useRef(false);
  const mounted = useRef(false);
  const sent = useRef(new Set<VastTrackingEvent>());
  const sentUrls = useRef(new Set<string>());
  const latest = useRef(props);
  latest.current = props;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lifetime = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastPosition = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const [needsPlay, setNeedsPlay] = useState(false);
  const consentGranted = () => latest.current.policy.enabled && latest.current.consent !== false && readConsent()?.ads === true;

  const sendUrls = (targets: readonly string[]) => {
    if (!mounted.current || !consentGranted()) return;
    for (const target of targets.slice(0, 20)) {
      try {
        const url = safeUrl(target);
        if (!url || sentUrls.current.has(url)) continue;
        sentUrls.current.add(url);
        const address = url.replace(/(?:\[CACHEBUSTING\]|%5BCACHEBUSTING%5D)/gi, String(Math.floor(10_000_000 + Math.random() * 90_000_000)))
          .replace(/(?:\[ERRORCODE\]|%5BERRORCODE%5D)/gi, '405');
        const image = new Image();
        image.referrerPolicy = 'no-referrer';
        image.src = address;
      } catch { /* Invalid tracking cannot interrupt playback. */ }
    }
  };
  const track = (event: VastTrackingEvent) => {
    if (!consentGranted() || sent.current.has(event)) return;
    sent.current.add(event);
    sendUrls(latest.current.creative.tracking[event] ?? []);
  };
  const stop = () => {
    clearTimeout(timer.current); clearTimeout(lifetime.current);
    const element = video.current;
    if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
  };
  const finish = (result: VastBreakResult) => {
    if (done.current || !mounted.current) return;
    done.current = true;
    stop();
    track(result);
    if (result === 'skip' && latest.current.onSkip) latest.current.onSkip();
    else if (result === 'error' && latest.current.onError) latest.current.onError(new Error('Advertisement playback failed.'));
    else latest.current.onDone(result);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const armTimeout = () => { clearTimeout(timer.current); timer.current = setTimeout(() => finishRef.current('error'), 15_000); };

  useEffect(() => {
    mounted.current = true;
    const element = video.current;
    const mediaUrl = safeUrl(latest.current.creative.mediaUrl);
    const duration = latest.current.creative.durationSeconds;
    if (!element || !mediaUrl || !Number.isFinite(duration) || duration <= 0 || duration > 600
      || !latest.current.policy.enabled || latest.current.consent === false || readConsent()?.ads !== true) {
      finishRef.current('error');
      return () => { mounted.current = false; };
    }
    element.src = mediaUrl;
    timer.current = setTimeout(() => finishRef.current('error'), 15_000);
    lifetime.current = setTimeout(() => finishRef.current('error'), (duration + 30) * 1000);
    let cancelled = false;
    void element.play().catch(() => { if (!cancelled && !done.current) setNeedsPlay(true); });
    return () => {
      cancelled = true; mounted.current = false;
      clearTimeout(timer.current); clearTimeout(lifetime.current);
      element.pause(); element.removeAttribute('src'); element.load();
    };
  }, [creative]);

  useEffect(() => {
    if (video.current) { video.current.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1; video.current.muted = muted; }
  }, [volume, muted]);

  useEffect(() => { if (props.consent === false || !props.policy.enabled) finishRef.current('error'); }, [props.consent, props.policy.enabled]);

  const skipAfter = policy.allowSkip && creative.skipAfterSeconds !== null && Number.isFinite(creative.skipAfterSeconds)
    && creative.skipAfterSeconds >= 0 && Number.isFinite(policy.skipAfterSeconds) && policy.skipAfterSeconds >= 0
    ? Math.min(creative.durationSeconds, Math.max(policy.skipAfterSeconds, creative.skipAfterSeconds)) : Infinity;
  const remaining = Math.max(0, Math.ceil(creative.durationSeconds - elapsed));
  const clickThrough = safeUrl(creative.clickThrough);

  return <div className="lumora-vast-break" data-player-ui="" role="region" aria-label="Advertisement">
    <video ref={video} playsInline muted={muted} disablePictureInPicture aria-label="Advertisement video"
      onPlaying={() => { if (done.current || !mounted.current) return; setNeedsPlay(false); track('impression'); track('start'); }}
      onWaiting={() => { if (!timer.current && !done.current && mounted.current) armTimeout(); }}
      onEnded={() => finish('complete')} onError={() => finish('error')}
      onTimeUpdate={(event) => {
        if (done.current || !mounted.current) return;
        if (!consentGranted()) { finish('error'); return; }
        const position = event.currentTarget.currentTime;
        if (!Number.isFinite(position) || position < 0 || position > creative.durationSeconds + 2) { finish('error'); return; }
        if (position > lastPosition.current) { lastPosition.current = position; setElapsed(position); armTimeout(); }
        if (position >= creative.durationSeconds * 0.25) track('firstQuartile');
        if (position >= creative.durationSeconds * 0.5) track('midpoint');
        if (position >= creative.durationSeconds * 0.75) track('thirdQuartile');
      }} />
    <div className="lumora-vast-label"><span>Advertisement</span><output aria-label="Advertisement remaining time">{remaining}s</output></div>
    {needsPlay ? <button className="lumora-vast-play" type="button" onClick={() => {
      if (!consentGranted()) { finish('error'); return; }
      armTimeout(); void video.current?.play().catch(() => finish('error'));
    }}>Play advertisement</button> : null}
    <div className="lumora-vast-actions">
      {clickThrough ? <a href={clickThrough} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={(event) => {
        if (!consentGranted() || done.current || !mounted.current) { event.preventDefault(); return; }
        sendUrls(creative.clickTracking ?? []);
      }}>Learn more</a> : null}
      {Number.isFinite(skipAfter) ? <button type="button" aria-label="Skip advertisement" disabled={elapsed < skipAfter}
        onClick={() => { if (lastPosition.current >= skipAfter) finish('skip'); }}>
        <span aria-live="polite">{elapsed < skipAfter ? `Skip in ${Math.ceil(skipAfter - elapsed)}s` : 'Skip advertisement'}</span>
      </button> : null}
    </div>
  </div>;
}
