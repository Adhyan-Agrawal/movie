import type { PlaybackAdPolicy } from '@/features/commerce/types';

/** Advances only with observed content playback; paused, seeking, and ad time are excluded by the caller. */
export function createVastSchedule(policy: PlaybackAdPolicy) {
  let watched = 0;
  let breaks = 0;
  let pending = false;
  let nextBreak = policy.firstBreakSeconds;
  return {
    advance(seconds: number): boolean {
      if (!policy.enabled || pending || breaks >= policy.maxBreaks || !Number.isFinite(seconds) || seconds <= 0) return false;
      watched += Math.min(seconds, 5);
      if (watched < nextBreak) return false;
      pending = true;
      return true;
    },
    finish() {
      if (!pending) return;
      breaks += 1;
      pending = false;
      nextBreak = watched + policy.intervalSeconds;
    },
    get completedBreaks() { return breaks; },
  };
}
