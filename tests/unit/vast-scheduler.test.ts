import { describe, expect, it } from 'vitest';
import { createAdSchedule, createVastSchedule, updateAdSchedule } from '@/features/ads/vast/scheduler';

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

  it('uses content position rather than elapsed wall time, including playback speed', () => {
    let schedule = createAdSchedule(POLICY);
    schedule = updateAdSchedule(schedule, { contentTimeSeconds: 9, paused: false }).schedule;
    const due = updateAdSchedule(schedule, { contentTimeSeconds: 10, paused: false });
    expect(due.dueBreak).toEqual({ id: 'vast-break-0', index: 0, contentTimeSeconds: 10 });
    expect(due.schedule.consumedBreaks).toBe(1);
    expect(schedule.consumedBreaks).toBe(0);
    expect(updateAdSchedule(due.schedule, { contentTimeSeconds: 10, paused: false }).dueBreak).toBeNull();
    const next = updateAdSchedule(due.schedule, { contentTimeSeconds: 30, paused: false });
    expect(next.dueBreak?.index).toBe(1);
    expect(updateAdSchedule(next.schedule, { contentTimeSeconds: 1000, paused: false }).dueBreak).toBeNull();
  });

  it('does not advance while paused or while an ad is fetching/playing', () => {
    const schedule = createAdSchedule(POLICY);
    expect(updateAdSchedule(schedule, { contentTimeSeconds: 10, paused: true }).schedule).toBe(schedule);
    expect(updateAdSchedule(schedule, { contentTimeSeconds: 600, paused: false, adPlaying: true }).schedule).toBe(schedule);
    expect(updateAdSchedule(schedule, { contentTimeSeconds: 10, paused: false }).dueBreak?.index).toBe(0);
  });

  it('never repeats a consumed break after backward seeking and repeated boundary samples', () => {
    const due = updateAdSchedule(createAdSchedule(POLICY), { contentTimeSeconds: 10, paused: false });
    let schedule = due.schedule;
    for (const position of [2, 5, 9, 10, 10, 15, 20, 29]) {
      const result = updateAdSchedule(schedule, { contentTimeSeconds: position, paused: false });
      expect(result.dueBreak).toBeNull();
      schedule = result.schedule;
    }
    expect(updateAdSchedule(schedule, { contentTimeSeconds: 30, paused: false }).dueBreak?.index).toBe(1);
  });

  it('skips seek-crossed breaks without catch-up bursts or replay after returning backwards', () => {
    const forward = updateAdSchedule(createAdSchedule(POLICY), { contentTimeSeconds: 25, paused: true, seeking: true });
    expect(forward.dueBreak).toBeNull();
    expect(forward.schedule.nextBreakIndex).toBe(1);
    expect(forward.schedule.consumedBreaks).toBe(0);
    expect(updateAdSchedule(forward.schedule, { contentTimeSeconds: 10, paused: false }).dueBreak).toBeNull();
    expect(updateAdSchedule(forward.schedule, { contentTimeSeconds: 30, paused: false }).dueBreak?.index).toBe(1);
    const exhausted = updateAdSchedule(createAdSchedule(POLICY), { contentTimeSeconds: 200, paused: false, seeking: true });
    expect(updateAdSchedule(exhausted.schedule, { contentTimeSeconds: 205, paused: false }).dueBreak).toBeNull();
  });

  it('initializes at exact saved content time and copies policy without changing checkpoints', () => {
    const checkpoint = { positionSeconds: 25.125, updatedAt: 100, pendingSync: true };
    const policy = { ...POLICY };
    const schedule = createAdSchedule(policy, { contentTimeSeconds: checkpoint.positionSeconds });
    policy.enabled = false; policy.intervalSeconds = 1;
    expect(updateAdSchedule(schedule, { contentTimeSeconds: 26, paused: false }).dueBreak).toBeNull();
    expect(updateAdSchedule(schedule, { contentTimeSeconds: 30, paused: false }).dueBreak?.index).toBe(1);
    expect(checkpoint).toEqual({ positionSeconds: 25.125, updatedAt: 100, pendingSync: true });
  });

  it.each([{ resolved: true, adFree: true }, { resolved: false, adFree: false }])('fails closed for ad-free/unresolved entitlement %j', (entitlements) => {
    const schedule = createAdSchedule(POLICY, { entitlements });
    expect(updateAdSchedule(schedule, { contentTimeSeconds: 100, paused: false }).dueBreak).toBeNull();
    expect(createVastSchedule(POLICY, 0, entitlements).update({ contentTimeSeconds: 10, paused: false })).toBe(false);
  });

  it.each([{ enabled: false }, { intervalSeconds: 0 }, { intervalSeconds: NaN }, { firstBreakSeconds: -1 },
    { maxBreaks: Infinity }, { maxBreaks: 21 }, { maxBreaks: 1.5 }, { maxBreaks: 0 }])('disables invalid schedule ranges %j', (override) => {
    expect(updateAdSchedule(createAdSchedule({ ...POLICY, ...override }), { contentTimeSeconds: 100, paused: false }).dueBreak).toBeNull();
  });

  it('treats skip, error and completion as the same single consumption in the mounted adapter', () => {
    const schedule = createVastSchedule(POLICY);
    expect(schedule.update({ contentTimeSeconds: 10, paused: false })).toBe(true);
    expect(schedule.consumedBreaks).toBe(1);
    expect(schedule.update({ contentTimeSeconds: 30, paused: false })).toBe(false);
    schedule.finish(); schedule.finish(); schedule.finish();
    expect(schedule.completedBreaks).toBe(1);
    expect(schedule.update({ contentTimeSeconds: 5, paused: false, seeking: true })).toBe(false);
    expect(schedule.update({ contentTimeSeconds: 10, paused: false })).toBe(false);
    expect(schedule.update({ contentTimeSeconds: 30, paused: false })).toBe(true);
    schedule.finish();
    expect(schedule.completedBreaks).toBe(2);
    expect(schedule.update({ contentTimeSeconds: 50, paused: false })).toBe(false);
  });
});
