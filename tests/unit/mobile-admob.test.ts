import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_IDS, resolveAdMobConfig } from '../../mobile/admob.config';
import { adMobAccountEligible, canUseAdMob, createAdMobBrowsingSchedule, type AdMobGate, type AdMobRoute } from '../../mobile/src/ads/policy';

const require = createRequire(import.meta.url);
const appConfig = require('../../mobile/app.config.js');
const gate: AdMobGate = { optedIn: true, umpEligible: true, accountId: 'signed-in-viewer',
  entitlements: { resolved: true, adFree: false, status: 'free', maxProfiles: 1 }, checkedAt: 1000,
  foreground: true, route: { root: 'Tabs', tab: 'Home' } };
const production = { appId: 'ca-app-pub-1234567890123456~1234567890', bannerId: 'ca-app-pub-1234567890123456/1234567890',
  interstitialId: 'ca-app-pub-1234567890123456/0987654321' };
afterEach(() => vi.unstubAllEnvs());

describe('AdMob safe public configuration', () => {
  it('defaults to official Google app/adaptive banner/interstitial demo IDs in release too', () => {
    expect(resolveAdMobConfig()).toEqual({ ...TEST_IDS, testAds: true });
    expect(TEST_IDS).toEqual({ appId: 'ca-app-pub-3940256099942544~3347511713',
      bannerId: 'ca-app-pub-3940256099942544/9214589741', interstitialId: 'ca-app-pub-3940256099942544/1033173712' });
  });
  it('requires explicit production mode and all validated public overrides', () => {
    expect(resolveAdMobConfig(production)).toEqual({ ...TEST_IDS, testAds: true });
    expect(resolveAdMobConfig({ ...production, testAds: 'false' })).toEqual({ ...production, testAds: false });
    expect(() => resolveAdMobConfig({ ...production, bannerId: undefined, testAds: 'false' })).toThrow('requires all three');
  });
  it('forces safe units for development even when production IDs/mode are configured', () => {
    expect(resolveAdMobConfig({ ...production, testAds: 'false', development: true })).toEqual({ ...TEST_IDS, testAds: true });
  });
  it.each([{ appId: 'ca-app-pub-1234567890123456/1234567890' }, { bannerId: 'ca-app-pub-1234567890123456~1234567890' },
    { interstitialId: 'javascript:alert(1)' }, { appId: 'private-value-do-not-print' }, { testAds: 'maybe' }])('rejects invalid configuration without exposing input %j', (input) => {
    expect(() => resolveAdMobConfig(input)).toThrow();
    try { resolveAdMobConfig(input); } catch (error) { expect(String(error)).not.toContain('private-value-do-not-print'); }
  });
  it('preserves existing Expo settings/plugins and uses nextgen/delayed measurement', () => {
    for (const key of ['EXPO_PUBLIC_ADMOB_ANDROID_APP_ID', 'EXPO_PUBLIC_ADMOB_ANDROID_BANNER_ID', 'EXPO_PUBLIC_ADMOB_ANDROID_INTERSTITIAL_ID', 'EXPO_PUBLIC_ADMOB_TEST_ADS']) vi.stubEnv(key, undefined);
    const original = { name: 'Lumora', android: { package: 'org.lumora.app' }, ios: { bundleIdentifier: 'org.lumora.app' },
      plugins: ['expo-video', 'expo-screen-orientation'], scheme: 'lumora' };
    const actual = appConfig({ config: original });
    expect(actual).toMatchObject({ name: original.name, android: original.android, ios: original.ios, scheme: original.scheme });
    expect(actual.plugins).toEqual([...original.plugins, ['react-native-google-mobile-ads', {
      androidAppId: TEST_IDS.appId, androidSdk: 'nextgen', delayAppMeasurementInit: true,
    }]]);
    expect(original.plugins).toHaveLength(2);
  });
});

describe('AdMob independent consent and account gates', () => {
  it('requires explicit AdMob opt-in as well as UMP eligibility and a fresh resolved ad-supported account', () => {
    expect(canUseAdMob(gate, 2000)).toBe(true);
    expect(canUseAdMob({ ...gate, optedIn: false }, 2000)).toBe(false);
    expect(canUseAdMob({ ...gate, umpEligible: false }, 2000)).toBe(false);
    expect(canUseAdMob({ ...gate, checkedAt: 1000 }, 61_000)).toBe(false);
    expect(canUseAdMob(gate, 999)).toBe(false);
    expect(canUseAdMob(gate, NaN)).toBe(false);
  });
  it.each([{ accountId: null }, { entitlements: null }, { entitlements: { ...gate.entitlements!, resolved: false } },
    { entitlements: { ...gate.entitlements!, adFree: true } }, { entitlements: { ...gate.entitlements!, status: 'unavailable' as const } }])('never treats guest/uncertain/ad-free state as eligible %j', (patch) => {
    expect(canUseAdMob({ ...gate, ...patch }, 2000)).toBe(false);
    expect(adMobAccountEligible(patch.accountId === undefined ? gate.accountId : patch.accountId,
      patch.entitlements === undefined ? gate.entitlements : patch.entitlements)).toBe(false);
  });
  it.each([null, { root: 'Player' }, { root: 'Auth' }, { root: 'Unknown' }])('blocks player/VAST/Up Next/startup/unknown routes %j', (route) => {
    expect(canUseAdMob({ ...gate, route }, 2000)).toBe(false);
  });
  it('never allows requests or presentation in the background', () => {
    expect(canUseAdMob({ ...gate, foreground: false }, 2000)).toBe(false);
  });
});

describe('AdMob safe completed browsing transition scheduling', () => {
  const home: AdMobRoute = { root: 'Tabs', tab: 'Home', key: 'tabs' };
  function visit(schedule: ReturnType<typeof createAdMobBrowsingSchedule>, n: number, now: number, duration = 10_000) {
    schedule.navigation({ root: 'Title', key: `title-${n}` }, now);
    return schedule.navigation(home, now + duration);
  }
  it('shows only after three sufficiently read catalog-origin detail visits and transition completion', () => {
    const schedule = createAdMobBrowsingSchedule(0);
    expect(schedule.navigation(home, 0)).toBe(false);
    expect(visit(schedule, 1, 120_000)).toBe(false);
    expect(visit(schedule, 2, 140_000)).toBe(false);
    expect(visit(schedule, 3, 160_000)).toBe(true);
    schedule.shown(170_000);
    expect(visit(schedule, 4, 180_000)).toBe(false);
    expect(visit(schedule, 5, 200_000)).toBe(false);
    expect(visit(schedule, 6, 220_000)).toBe(false);
    expect(visit(schedule, 7, 290_000)).toBe(true);
    schedule.shown(300_000);
    for (let n = 8; n < 20; n += 1) expect(visit(schedule, n, 400_000 + n * 20_000)).toBe(false);
  });
  it('never triggers on initial navigation, app launch, direct title deep link, tab switching, or rapid taps', () => {
    const schedule = createAdMobBrowsingSchedule(0);
    expect(schedule.navigation({ root: 'Title', key: 'deep-link' }, 0)).toBe(false);
    expect(schedule.navigation(home, 150_000)).toBe(false);
    for (let n = 0; n < 10; n += 1) expect(visit(schedule, n, 150_000 + n * 20_000, 1000)).toBe(false);
    expect(schedule.navigation({ root: 'Tabs', tab: 'Search' }, 400_000)).toBe(false);
    expect(schedule.navigation(home, 500_000)).toBe(false);
  });
  it('suppresses all playback-related transitions including Player return, Up Next, and title visits near playback', () => {
    const schedule = createAdMobBrowsingSchedule(0);
    schedule.navigation(home, 120_000);
    schedule.navigation({ root: 'Title', key: 'before-player' }, 130_000);
    expect(schedule.navigation({ root: 'Player', key: 'video' }, 150_000)).toBe(false);
    expect(schedule.navigation({ root: 'Player', key: 'up-next' }, 250_000)).toBe(false);
    schedule.navigation({ root: 'Title', key: 'return-from-player' }, 400_000);
    expect(schedule.navigation(home, 420_000)).toBe(false);
    expect(visit(schedule, 1, 430_000)).toBe(false);
    expect(visit(schedule, 2, 450_000)).toBe(false);
    expect(visit(schedule, 3, 470_000)).toBe(true);
  });
  it('drops browse state on auth/privacy/background cancellation and never counts startup browsing', () => {
    const schedule = createAdMobBrowsingSchedule(0);
    schedule.navigation(home, 0);
    for (let n = 0; n < 5; n += 1) expect(visit(schedule, n, n * 20_000)).toBe(false);
    expect(visit(schedule, 5, 120_000)).toBe(false);
    expect(visit(schedule, 6, 140_000)).toBe(false);
    schedule.navigation({ root: 'Title', key: 'suspended' }, 160_000);
    schedule.cancel();
    expect(schedule.navigation(home, 300_000)).toBe(false);
    expect(visit(schedule, 7, 310_000)).toBe(false);
  });
});
