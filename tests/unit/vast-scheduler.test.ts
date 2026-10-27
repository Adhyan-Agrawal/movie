import { describe, expect, it } from 'vitest';
import { createVastSchedule } from '@/features/ads/vast/scheduler';

const POLICY = { enabled: true, firstBreakSeconds: 10, intervalSeconds: 20, maxBreaks: 2, allowSkip: true, skipAfterSeconds: 5 };

describe('VAST content-playback schedule', () => {
  it('triggers once at the configured first break and excludes pending ad time', () => {
    const schedule = createVastSchedule(POLICY);
    expect(schedule.advance(5)).toBe(false);
    expect(schedule.advance(5)).toBe(true);
    expect(schedule.advance(5)).toBe(false);
    schedule.finish();
    expect(schedule.completedBreaks).toBe(1);
    for (let index = 0; index < 3; index++) expect(schedule.advance(5)).toBe(false);
    expect(schedule.advance(5)).toBe(true);
    schedule.finish();
    expect(schedule.advance(100)).toBe(false);
  });

  it('does not trigger for disabled policies or invalid/rewound time deltas', () => {
    const disabled = createVastSchedule({ ...POLICY, enabled: false });
    expect(disabled.advance(1000)).toBe(false);
    const schedule = createVastSchedule(POLICY);
    for (const delta of [0, -10, NaN, Infinity]) expect(schedule.advance(delta)).toBe(false);
    expect(schedule.advance(5)).toBe(false);
  });

  it('limits background timer gaps and counts failed/skipped breaks only once', () => {
    const schedule = createVastSchedule(POLICY);
    expect(schedule.advance(600)).toBe(false);
    expect(schedule.advance(5)).toBe(true);
    schedule.finish(); schedule.finish();
    expect(schedule.completedBreaks).toBe(1);
    expect(schedule.advance(5)).toBe(false);
  });
});
