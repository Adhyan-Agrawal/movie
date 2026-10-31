import type { ViewerEntitlements } from '../lib/types';

export interface AdMobRoute { root: string; tab?: string; key?: string }
export interface AdMobGate {
  optedIn: boolean; umpEligible: boolean; accountId: string | null; entitlements: ViewerEntitlements | null;
  checkedAt: number; foreground: boolean; route: AdMobRoute | null;
}

export function adMobAccountEligible(accountId: string | null, entitlements: ViewerEntitlements | null): boolean {
  return !!accountId && entitlements?.resolved === true && entitlements.adFree === false
    && ['free', 'active', 'expired'].includes(entitlements.status);
}

export function canUseAdMob(gate: AdMobGate, now: number): boolean {
  return gate.optedIn === true && gate.umpEligible === true && gate.foreground === true
    && !!gate.route && ['Tabs', 'Title', 'Person'].includes(gate.route.root)
    && Number.isFinite(now) && now >= gate.checkedAt && now - gate.checkedAt < 60_000
    && adMobAccountEligible(gate.accountId, gate.entitlements);
}

const catalog = (route: AdMobRoute | null) => route?.root === 'Tabs' && ['Home', 'Search', 'MyList'].includes(route.tab ?? '');

/** Only completed catalog-origin detail visits qualify, never a return from video. */
export function createAdMobBrowsingSchedule(startedAt: number) {
  let previous: AdMobRoute | null = null;
  let detail: { key?: string; enteredAt: number } | null = null;
  let lastPlayback = -Infinity; let lastShown = -Infinity; let visits = 0; let shown = 0;
  return {
    navigation(route: AdMobRoute, now: number) {
      const last = previous; previous = route;
      if (route.root === 'Player') { lastPlayback = now; detail = null; visits = 0; return false; }
      if (route.root === 'Title' && (last?.root !== 'Title' || last.key !== route.key)) {
        detail = catalog(last) ? { key: route.key, enteredAt: now } : null;
        return false;
      }
      if (last?.root !== 'Title' || route.root === 'Title') return false;
      const completed = detail; detail = null;
      if (!completed || completed.key !== last.key || !catalog(route) || !Number.isFinite(now)
        || now - completed.enteredAt < 10_000 || now - startedAt < 120_000 || now - lastPlayback < 120_000) return false;
      visits += 1;
      return visits >= 3 && shown < 2 && now - lastShown >= 120_000;
    },
    shown(now: number) { shown += 1; visits = 0; lastShown = now; },
    cancel() { detail = null; visits = 0; },
  };
}
