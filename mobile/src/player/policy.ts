import type { NativeAdPolicy, PlaybackResponse } from '../lib/types';

/** A native ad executor may be registered by the shared-policy integration, not by the player UI. */
export type AdBreakHandler = (input: { policy: NonNullable<PlaybackResponse['adPolicy']>; positionSeconds: number; phase: 'start' | 'progress' }) => void;
let handler: AdBreakHandler | undefined;
export function registerAdBreakHandler(next: AdBreakHandler | undefined): void { handler = next; }
export function notifyAdBreak(input: Parameters<AdBreakHandler>[0]): void {
  if (input.policy.enabled === true) handler?.(input);
}

export function createNativeAdSchedule(policy: NativeAdPolicy) {
  let watched = 0; let next = policy.firstBreakSeconds; let pending = false; let count = 0;
  return {
    advance(seconds: number) {
      if (!policy.enabled || pending || count >= policy.maxBreaks || !Number.isFinite(seconds) || seconds <= 0) return false;
      watched += Math.min(5, seconds);
      if (watched < next) return false;
      pending = true; return true;
    },
    finish() { if (pending) { pending = false; count += 1; next = watched + policy.intervalSeconds; } },
  };
}
