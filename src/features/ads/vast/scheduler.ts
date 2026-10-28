import type { PlaybackAdPolicy, ViewerEntitlements } from '@/features/commerce/types';

export interface AdContentUpdate {
  contentTimeSeconds: number;
  paused: boolean;
  seeking?: boolean;
  adPlaying?: boolean;
}

export interface AdSchedule {
  readonly policy: Readonly<PlaybackAdPolicy>;
  readonly highWaterSeconds: number;
  readonly nextBreakIndex: number;
  readonly consumedBreaks: number;
}

export interface ScheduledAdBreak { id: string; index: number; contentTimeSeconds: number }
type AdEligibility = Pick<ViewerEntitlements, 'resolved' | 'adFree'>;

const validTime = (value: number) => Number.isFinite(value) && value >= 0;
const nextIndex = (policy: PlaybackAdPolicy, position: number) => position < policy.firstBreakSeconds
  ? 0 : Math.floor((position - policy.firstBreakSeconds) / policy.intervalSeconds) + 1;

/** Initialize at the actual resume position. Earlier breaks are not replayed on reload. */
export function createAdSchedule(policy: PlaybackAdPolicy, options: { contentTimeSeconds?: number; entitlements?: AdEligibility } = {}): AdSchedule {
  const valid = validTime(policy.firstBreakSeconds) && policy.firstBreakSeconds > 0
    && validTime(policy.intervalSeconds) && policy.intervalSeconds > 0
    && Number.isInteger(policy.maxBreaks) && policy.maxBreaks > 0 && policy.maxBreaks <= 20;
  const position = validTime(options.contentTimeSeconds ?? 0) ? options.contentTimeSeconds ?? 0 : 0;
  const safePolicy: PlaybackAdPolicy = { enabled: policy.enabled && valid
    && (!options.entitlements || (options.entitlements.resolved && !options.entitlements.adFree)),
  firstBreakSeconds: policy.firstBreakSeconds, intervalSeconds: policy.intervalSeconds, maxBreaks: policy.maxBreaks,
  allowSkip: policy.allowSkip, skipAfterSeconds: policy.skipAfterSeconds };
  return { policy: safePolicy, highWaterSeconds: position, nextBreakIndex: valid ? nextIndex(safePolicy, position) : 0, consumedBreaks: 0 };
}

/** Consume on issuance, never on completion. No wall clock or content checkpoint writes. */
export function updateAdSchedule(schedule: AdSchedule, update: AdContentUpdate): { schedule: AdSchedule; dueBreak: ScheduledAdBreak | null } {
  if (!schedule.policy.enabled || !validTime(update.contentTimeSeconds) || update.adPlaying
    || (update.paused && !update.seeking)
    || update.contentTimeSeconds <= schedule.highWaterSeconds) return { schedule, dueBreak: null };
  const position = update.contentTimeSeconds;
  const index = schedule.nextBreakIndex;
  const threshold = schedule.policy.firstBreakSeconds + index * schedule.policy.intervalSeconds;
  const crossed = position >= threshold;
  const following = crossed ? Math.max(index + 1, nextIndex(schedule.policy, position)) : index;
  const due = crossed && !update.paused && !update.seeking && index < schedule.policy.maxBreaks
    && schedule.consumedBreaks < schedule.policy.maxBreaks;
  return { schedule: { ...schedule, highWaterSeconds: position, nextBreakIndex: following,
    consumedBreaks: schedule.consumedBreaks + (due ? 1 : 0) },
  dueBreak: due ? { id: `vast-break-${index}`, index, contentTimeSeconds: threshold } : null };
}

/** Stateful adapter for the mounted player; use update with observed content time. */
export function createVastSchedule(policy: PlaybackAdPolicy, initialContentTimeSeconds = 0, entitlements?: AdEligibility) {
  let state = createAdSchedule(policy, { contentTimeSeconds: initialContentTimeSeconds, entitlements });
  let pending = false;
  let completed = 0;
  const update = (input: AdContentUpdate): boolean => {
    if (pending) return false;
    const result = updateAdSchedule(state, input);
    state = result.schedule;
    pending = result.dueBreak !== null;
    return pending;
  };
  return {
    update,
    // Existing delta callers must supply measured content deltas, never performance.now().
    advance(seconds: number): boolean {
      return Number.isFinite(seconds) && seconds > 0
        ? update({ contentTimeSeconds: state.highWaterSeconds + Math.min(seconds, 5), paused: false }) : false;
    },
    finish() { if (pending) { completed += 1; pending = false; } },
    get completedBreaks() { return completed; },
    get consumedBreaks() { return state.consumedBreaks; },
  };
}
