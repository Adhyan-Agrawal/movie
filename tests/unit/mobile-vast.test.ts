import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { NativeAdPolicy, NativeVastCreative } from '../../mobile/src/lib/types';
import type { PlaybackAdPolicy } from '../../src/features/commerce/types';
import type { VastCreative } from '../../src/features/ads/vast/types';
import { createVastSchedule } from '../../src/features/ads/vast/scheduler';
import { createNativeAdResume, createNativeAdSchedule, createNativeAdTracking, nativeAdHttpsUrl, nativeAdSkipAfter, validNativeAdPolicy } from '../../mobile/src/player/policy';

const policy: NativeAdPolicy = { enabled: true, firstBreakSeconds: 60, intervalSeconds: 60, maxBreaks: 2, allowSkip: true, skipAfterSeconds: 5 };
const creative: NativeVastCreative = { id: 'fixture', mediaUrl: 'https://ads.example.com/ad.mp4', durationSeconds: 30,
  skipAfterSeconds: 8, tracking: {}, clickThrough: 'https://ads.example.com/details' };
const observation = (positionSeconds: number, nowMs = positionSeconds * 1000) => ({ positionSeconds, nowMs,
  playing: true, ready: true, foreground: true, playbackRate: 1 });

describe('Native VAST public contract and scheduler parity', () => {
  it('has no raw ad executor notification path and passes policy only with resolved non-ad-free context', () => {
    const screen = readFileSync(new URL('../../mobile/src/screens/PlayerScreen.tsx', import.meta.url), 'utf8');
    const nativePolicy = readFileSync(new URL('../../mobile/src/player/policy.ts', import.meta.url), 'utf8');
    expect(screen).not.toContain('notifyAdBreak');
    expect(nativePolicy).not.toContain('notifyAdBreak');
    expect(screen).toContain('adPolicy={bridge.entitlements?.resolved === true && bridge.entitlements.adFree === false ? bridge.adPolicy : undefined}');
  });
  it('mirrors public commerce/creative DTOs without tag or provider secrets', () => {
    expectTypeOf<NativeAdPolicy>().toEqualTypeOf<PlaybackAdPolicy>();
    expectTypeOf<NativeVastCreative>().toEqualTypeOf<VastCreative>();
    expect(Object.keys(policy).sort()).toEqual(['allowSkip', 'enabled', 'firstBreakSeconds', 'intervalSeconds', 'maxBreaks', 'skipAfterSeconds']);
  });

  it('matches web first/interval/max-break scheduling for continuous observed playback', () => {
    const native = createNativeAdSchedule(policy);
    const web = createVastSchedule(policy);
    const breaks: number[] = [];
    for (let second = 1; second <= 240; second += 1) {
      const due = native.advance(1);
      expect(due).toBe(web.advance(1));
      if (due) {
        breaks.push(second);
        expect(native.advance(5)).toBe(false);
        native.finish(); web.finish();
      }
    }
    expect(breaks).toEqual([60, 120]);
    expect(native.completedBreaks).toBe(web.completedBreaks);
  });

  it('counts actual content advances, not paused, buffering, or background wall time', () => {
    const schedule = createNativeAdSchedule(policy);
    schedule.sample(observation(0));
    for (let n = 1; n <= 59; n += 1) expect(schedule.sample(observation(n))).toBe(false);
    expect(schedule.sample({ ...observation(1000, 60_000), playing: false })).toBe(false);
    expect(schedule.sample({ ...observation(1001, 61_000), ready: false })).toBe(false);
    expect(schedule.sample({ ...observation(1002, 62_000), foreground: false })).toBe(false);
    expect(schedule.sample(observation(1003, 63_000))).toBe(false);
    expect(schedule.sample(observation(1004, 64_000))).toBe(true);
  });

  it('seeks, repeated pause/play events, replacement resets, and long event gaps cannot spam breaks', () => {
    const schedule = createNativeAdSchedule(policy);
    schedule.sample(observation(0));
    for (let n = 1; n <= 59; n += 1) schedule.sample(observation(n));
    expect(schedule.sample(observation(5000, 60_000))).toBe(false);
    expect(schedule.sample(observation(0, 61_000))).toBe(false);
    for (let n = 0; n < 100; n += 1) {
      schedule.resetObservation();
      expect(schedule.sample(observation(5000 + n, 62_000 + n * 1000))).toBe(false);
    }
    expect(schedule.sample(observation(6000, 300_000))).toBe(false);
    expect(schedule.sample(observation(6001, 301_000))).toBe(true);
    expect(schedule.sample(observation(6002, 302_000))).toBe(false);
    schedule.finish(); schedule.finish();
    expect(schedule.completedBreaks).toBe(1);
    schedule.sample(observation(6001, 400_000));
    for (let n = 1; n < 60; n += 1) expect(schedule.sample(observation(6001 + n, 400_000 + n * 1000))).toBe(false);
    expect(schedule.sample(observation(6061, 460_000))).toBe(true);
    schedule.finish();
    expect(schedule.advance(600)).toBe(false);
  });

  it('uses content time at the selected rate, never a clock-only advance', () => {
    const schedule = createNativeAdSchedule(policy);
    schedule.sample({ ...observation(0, 0), playbackRate: 2 });
    for (let n = 1; n < 30; n += 1) expect(schedule.sample({ ...observation(n * 2, n * 1000), playbackRate: 2 })).toBe(false);
    expect(schedule.sample({ ...observation(60, 30_000), playbackRate: 2 })).toBe(true);
  });

  it('unchanged content position and invalid observations never accumulate elapsed time', () => {
    const schedule = createNativeAdSchedule(policy);
    for (let n = 0; n < 500; n += 1) expect(schedule.sample(observation(0, n * 1000))).toBe(false);
    expect(schedule.sample(observation(NaN, 600_000))).toBe(false);
    expect(schedule.sample(observation(-1, 601_000))).toBe(false);
    expect(schedule.sample({ ...observation(0, 602_000), playbackRate: NaN })).toBe(false);
    expect(schedule.sample(observation(1, 603_000))).toBe(false);
  });

  it.each([{ ...policy, enabled: false }, { ...policy, maxBreaks: 0 }, { ...policy, maxBreaks: 21 },
    { ...policy, firstBreakSeconds: NaN }, { ...policy, intervalSeconds: 0 }, { ...policy, skipAfterSeconds: -1 }])('fails closed for disabled or malformed policy %j', (value) => {
    expect(validNativeAdPolicy(value)).toBe(false);
    expect(createNativeAdSchedule(value).advance(60)).toBe(false);
  });
});

describe('Native VAST content resume isolation', () => {
  it.each(['completion', 'skip', 'error', 'no-fill'])('restores fractional position/play/rate after %s without replacing the source', () => {
    const player = { currentTime: 125.375, playbackRate: 1.5, playing: true, uri: 'content-capability',
      pause: vi.fn(), play: vi.fn(), replaceAsync: vi.fn() };
    const saved = createNativeAdResume(player);
    expect(player.pause).toHaveBeenCalledOnce();
    player.currentTime = 126; player.playbackRate = 1;
    saved.restore(true);
    expect(player.currentTime).toBe(125.375);
    expect(player.playbackRate).toBe(1.5);
    expect(player.play).toHaveBeenCalledOnce();
    expect(player.uri).toBe('content-capability');
    expect(player.replaceAsync).not.toHaveBeenCalled();
  });

  it('background cancellation restores the point/rate but defers play until foreground', () => {
    const player = { currentTime: 0, playbackRate: 0.75, playing: true, pause: vi.fn(), play: vi.fn() };
    const saved = createNativeAdResume(player);
    saved.restore(false);
    expect(player.play).not.toHaveBeenCalled();
    expect(player.currentTime).toBe(0);
    expect(player.playbackRate).toBe(0.75);
    saved.restore(true);
    expect(player.play).toHaveBeenCalledOnce();
  });

  it('never starts content that was intentionally paused before a break', () => {
    const player = { currentTime: 25.25, playbackRate: 2, playing: false, pause: vi.fn(), play: vi.fn() };
    createNativeAdResume(player).restore(true);
    expect(player.play).not.toHaveBeenCalled();
    expect(player.pause).toHaveBeenCalledTimes(2);
  });
});

describe('Native VAST skip and once-only tracking', () => {
  it('enforces both admin permission and the later admin/creative skip offset', () => {
    expect(nativeAdSkipAfter(policy, creative)).toBe(8);
    expect(nativeAdSkipAfter({ ...policy, skipAfterSeconds: 10 }, creative)).toBe(10);
    expect(nativeAdSkipAfter({ ...policy, allowSkip: false }, creative)).toBe(Infinity);
    expect(nativeAdSkipAfter(policy, { ...creative, skipAfterSeconds: null })).toBe(Infinity);
    expect(nativeAdSkipAfter(policy, { ...creative, skipAfterSeconds: NaN })).toBe(Infinity);
  });

  it('sends no impression, quartile, error, completion, skip, or click before native playing', () => {
    const send = vi.fn();
    const ad = { ...creative, tracking: { impression: ['https://ads.example.com/impression'], error: ['https://ads.example.com/error'],
      complete: ['https://ads.example.com/complete'], skip: ['https://ads.example.com/skip'] }, clickTracking: ['https://ads.example.com/click'] };
    const tracker = createNativeAdTracking(ad, send);
    for (const event of ['impression', 'start', 'firstQuartile', 'error', 'complete', 'skip', 'click'] as const) tracker.track(event);
    expect(send).not.toHaveBeenCalled();
    tracker.playing(); tracker.track('impression');
    expect(send).toHaveBeenCalledExactlyOnceWith('https://ads.example.com/impression');
  });

  it('dedupes repeated playing/quartile/click events and unsafe or repeated HTTPS URLs', () => {
    const send = vi.fn();
    const shared = 'https://ads.example.com/shared';
    const tracker = createNativeAdTracking({ ...creative, tracking: { impression: [shared, shared, 'http://ads.example.com/no', 'https://u:p@ads.example.com/no'],
      start: [shared], midpoint: ['https://ads.example.com/mid'] }, clickTracking: [shared, 'https://ads.example.com/click'] }, send);
    for (let n = 0; n < 5; n += 1) { tracker.playing(); tracker.track('impression'); tracker.track('start'); tracker.track('midpoint'); tracker.track('click'); }
    expect(send.mock.calls.map(([url]) => url)).toEqual([shared, 'https://ads.example.com/mid', 'https://ads.example.com/click']);
  });

  it('expands bounded standard macros and ignores tracking failures', () => {
    const send = vi.fn((_url: string) => { throw new Error('offline'); });
    const tracker = createNativeAdTracking({ ...creative, tracking: { error: ['https://ads.example.com/error?code=[ERRORCODE]&cb=[CACHEBUSTING]'] } }, send);
    tracker.playing();
    expect(() => tracker.track('error')).not.toThrow();
    expect(send.mock.calls[0]?.[0]).toMatch(/code=405&cb=\d{8}$/);
    tracker.track('error');
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(['javascript:alert(1)', 'http://ads.example.com/ad', 'https://u:p@ads.example.com/ad', 'https://ads.example.com:8443/ad', 'https://ads.example.com/ad#fragment'])('rejects unsafe click/beacon URL %s', (url) => {
    expect(nativeAdHttpsUrl(url)).toBeNull();
  });
});
