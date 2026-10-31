import type { NativeAdPolicy, NativeVastCreative } from '../lib/types';

export function validNativeAdPolicy(policy: NativeAdPolicy | undefined): policy is NativeAdPolicy {
  return !!policy && policy.enabled === true && typeof policy.allowSkip === 'boolean'
    && Number.isInteger(policy.firstBreakSeconds) && policy.firstBreakSeconds >= 60 && policy.firstBreakSeconds <= 86400
    && Number.isInteger(policy.intervalSeconds) && policy.intervalSeconds >= 60 && policy.intervalSeconds <= 86400
    && Number.isInteger(policy.maxBreaks) && policy.maxBreaks >= 1 && policy.maxBreaks <= 20
    && Number.isInteger(policy.skipAfterSeconds) && policy.skipAfterSeconds >= 0 && policy.skipAfterSeconds <= 30;
}

interface ContentObservation {
  positionSeconds: number; nowMs: number; playing: boolean; ready: boolean; foreground: boolean; playbackRate: number;
}

export function createNativeAdSchedule(policy: NativeAdPolicy) {
  let watched = 0; let next = policy.firstBreakSeconds; let pending = false; let count = 0;
  let previous: ContentObservation | null = null;
  const schedule = {
    advance(seconds: number) {
      if (!validNativeAdPolicy(policy) || pending || count >= policy.maxBreaks || !Number.isFinite(seconds) || seconds <= 0) return false;
      watched += Math.min(5, seconds);
      if (watched < next) return false;
      pending = true; return true;
    },
    sample(value: ContentObservation) {
      const last = previous;
      previous = value;
      if (!last || pending || !value.playing || !last.playing || !value.ready || !last.ready
        || !value.foreground || !last.foreground || value.playbackRate !== last.playbackRate
        || !Number.isFinite(value.positionSeconds) || value.positionSeconds < 0
        || !Number.isFinite(value.playbackRate) || value.playbackRate <= 0) return false;
      const elapsed = (value.nowMs - last.nowMs) / 1000;
      const delta = value.positionSeconds - last.positionSeconds;
      // Long event gaps and discontinuities are seeks/suspension, not watched time.
      if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 2 || !Number.isFinite(delta) || delta <= 0
        || delta > elapsed * value.playbackRate + 0.35) return false;
      return schedule.advance(delta);
    },
    resetObservation() { previous = null; },
    finish() { if (pending) { pending = false; count += 1; next = watched + policy.intervalSeconds; } previous = null; },
    get completedBreaks() { return count; },
  };
  return schedule;
}

export function createNativeAdResume(player: {
  currentTime: number; playbackRate: number; playing: boolean; play(): void; pause(): void;
}) {
  const saved = { positionSeconds: player.currentTime, playbackRate: player.playbackRate, playing: player.playing };
  player.pause();
  return { ...saved, restore(foreground: boolean) {
    player.currentTime = saved.positionSeconds;
    player.playbackRate = saved.playbackRate;
    if (saved.playing && foreground) player.play();
    else player.pause();
  } };
}

export function nativeAdSkipAfter(policy: NativeAdPolicy, creative: NativeVastCreative): number {
  return policy.allowSkip === true && creative.skipAfterSeconds !== null
    && Number.isFinite(creative.skipAfterSeconds) && creative.skipAfterSeconds >= 0
    && Number.isFinite(policy.skipAfterSeconds) && policy.skipAfterSeconds >= 0
    ? Math.max(policy.skipAfterSeconds, creative.skipAfterSeconds) : Infinity;
}

export function nativeAdHttpsUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && (!url.port || url.port === '443') ? url.href : null;
  } catch { return null; }
}

/** Pure event collection only; the native player delivers no third-party beacons. */
export function createNativeAdTracking(creative: NativeVastCreative, send: (url: string) => void) {
  let started = false;
  const events = new Set<string>();
  const urls = new Set<string>();
  return {
    playing() { started = true; },
    track(event: keyof NativeVastCreative['tracking'] | 'click') {
      if (!started || events.has(event)) return;
      events.add(event);
      for (const raw of event === 'click' ? creative.clickTracking ?? [] : creative.tracking[event] ?? []) {
        const url = nativeAdHttpsUrl(raw);
        if (!url || urls.has(url)) continue;
        urls.add(url);
        try {
          send(url.replace(/(?:\[CACHEBUSTING\]|%5BCACHEBUSTING%5D)/gi, String(Math.floor(10_000_000 + Math.random() * 90_000_000)))
            .replace(/(?:\[ERRORCODE\]|%5BERRORCODE%5D)/gi, '405'));
        } catch { /* Tracking never blocks content. */ }
      }
    },
  };
}
