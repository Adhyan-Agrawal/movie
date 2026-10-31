import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hook/event harness for JS gates only; it does not simulate native Google ad rendering.
const mock = vi.hoisted(() => ({
  hooks: [] as any[], cursor: 0, pending: [] as Array<() => void>, dirty: false, context: null as any,
  profile: { accountId: 'viewer', entitlements: { resolved: true, adFree: false, status: 'free', maxProfiles: 1 } } as any,
  fetchProfile: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), initialize: vi.fn(), updateConsent: vi.fn(), gatherConsent: vi.fn(),
  createAd: vi.fn(), appCallback: null as null | ((state: string) => void), focused: true,
  authCallback: null as null | ((event: string, session?: any) => void),
  ad: { loaded: true, load: vi.fn(), show: vi.fn(), destroy: vi.fn(), addAdEventListener: vi.fn((_event: string, _callback: () => void) => vi.fn()) },
  app: { currentState: 'active', addEventListener: vi.fn() },
}));
vi.mock('../../mobile/node_modules/react', async (original) => ({ ...await original<typeof import('react')>(),
  createContext: () => ({ Provider: 'ContextProvider' }), useContext: () => mock.context,
  useState: (initial: any) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [mock.hooks[index], (next: any) => {
      const value = typeof next === 'function' ? next(mock.hooks[index]) : next;
      if (value !== mock.hooks[index]) { mock.hooks[index] = value; mock.dirty = true; }
    }];
  },
  useRef: (initial: any) => { const index = mock.cursor++; return mock.hooks[index] ??= { current: initial }; },
  useEffect: (effect: () => any, deps: any[]) => {
    const index = mock.cursor++;
    const previous = mock.hooks[index];
    if (!previous || deps.some((dep, n) => dep !== previous.deps[n])) {
      mock.hooks[index] = { deps, cleanup: previous?.cleanup };
      mock.pending.push(() => { previous?.cleanup?.(); mock.hooks[index].cleanup = effect(); });
    }
  },
}));
vi.mock('../../mobile/node_modules/react-native', () => ({ AppState: mock.app, Platform: { OS: 'android' },
  Text: 'Text', View: 'View', useWindowDimensions: () => ({ width: 400 }), StyleSheet: { create: (value: any) => value } }));
vi.mock('../../mobile/node_modules/@react-navigation/native/lib/module/index.js', () => ({ useIsFocused: () => mock.focused }));
vi.mock('../../mobile/node_modules/@react-native-async-storage/async-storage/lib/commonjs/index.js', () => ({ default: { getItem: mock.getItem, setItem: mock.setItem } }));
vi.mock('../../mobile/src/components/ui', () => ({ Button: 'Button' }));
vi.mock('../../mobile/src/lib/supabase', () => ({ supabase: { auth: {
  onAuthStateChange: (callback: typeof mock.authCallback) => { mock.authCallback = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; },
} } }));
vi.mock('../../mobile/src/ads/entitlements', () => ({ fetchAdMobEntitlements: mock.fetchProfile }));
vi.mock('../../mobile/node_modules/react-native-google-mobile-ads/lib/module/index.js', () => ({
  default: () => ({ initialize: mock.initialize }), AdsConsent: { requestInfoUpdate: mock.updateConsent, gatherConsent: mock.gatherConsent,
    showPrivacyOptionsForm: mock.gatherConsent }, AdsConsentPrivacyOptionsRequirementStatus: { REQUIRED: 'REQUIRED' },
  BannerAd: 'BannerAd', BannerAdSize: { INLINE_ADAPTIVE_BANNER: 'INLINE' },
  InterstitialAd: { createForAdRequest: mock.createAd }, AdEventType: { LOADED: 'loaded', ERROR: 'error', CLOSED: 'closed' },
}));
vi.stubGlobal('__DEV__', false);
const componentPath = '../../mobile/src/ads/AdMobProvider';
const { AdMobProvider, HomeAdMobBanner } = await import(componentPath);

function render() {
  mock.cursor = 0; mock.dirty = false;
  mock.context = AdMobProvider({ children: null }).props.value;
  const effects = mock.pending.splice(0);
  effects.forEach((effect) => effect());
}
async function flush() {
  for (let n = 0; n < 20; n += 1) {
    await Promise.resolve();
    if (mock.dirty) render();
  }
}
async function mount() { render(); await flush(); }
const navigate = async (root: string, tab?: string, key = root) => { mock.context.navigation({ root, tab, key }); await flush(); };

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1000); vi.clearAllMocks();
  mock.hooks = []; mock.cursor = 0; mock.pending = []; mock.dirty = false; mock.context = null;
  mock.app.currentState = 'active'; mock.focused = true;
  mock.profile = { accountId: 'viewer', entitlements: { resolved: true, adFree: false, status: 'free', maxProfiles: 1 } };
  mock.fetchProfile.mockImplementation(async () => mock.profile);
  mock.getItem.mockResolvedValue('false'); mock.setItem.mockResolvedValue(undefined);
  mock.initialize.mockResolvedValue(undefined);
  mock.updateConsent.mockResolvedValue({ canRequestAds: true, privacyOptionsRequirementStatus: 'NOT_REQUIRED' });
  mock.gatherConsent.mockResolvedValue({ canRequestAds: true, privacyOptionsRequirementStatus: 'NOT_REQUIRED' });
  mock.createAd.mockReturnValue(mock.ad); mock.ad.show.mockResolvedValue(undefined); mock.ad.loaded = true;
  mock.app.addEventListener.mockImplementation((_event, callback) => { mock.appCallback = callback; return { remove: vi.fn() }; });
});
afterEach(() => {
  mock.hooks.forEach((hook) => hook?.cleanup?.());
  vi.useRealTimers();
});

describe('AdMob native JS lifecycle gates', () => {
  it('makes no UMP/SDK/ad requests for default opt-out even with a resolved ad-supported account', async () => {
    await mount(); await navigate('Tabs', 'Home');
    expect(mock.context.gate.optedIn).toBe(false);
    expect(mock.updateConsent).not.toHaveBeenCalled();
    expect(mock.initialize).not.toHaveBeenCalled(); expect(mock.createAd).not.toHaveBeenCalled();
  });
  it.each([null, { accountId: 'viewer', entitlements: null },
    { accountId: 'viewer', entitlements: { resolved: true, adFree: true, status: 'active', maxProfiles: 1 } }])('keeps guest/unresolved/ad-free off even with a stored opt-in %j', async (profile) => {
    mock.profile = profile; mock.getItem.mockResolvedValue('true');
    await mount(); await navigate('Tabs', 'Home');
    expect(mock.initialize).not.toHaveBeenCalled(); expect(mock.createAd).not.toHaveBeenCalled();
  });
  it('does not treat app opt-in as UMP eligibility', async () => {
    mock.getItem.mockResolvedValue('true'); mock.updateConsent.mockResolvedValue({ canRequestAds: false });
    await mount(); await navigate('Tabs', 'Home');
    expect(mock.updateConsent).toHaveBeenCalled();
    expect(mock.initialize).not.toHaveBeenCalled(); expect(mock.createAd).not.toHaveBeenCalled();
  });
  it('requires explicit Account choice and UMP success before initialization/preload, and never shows at startup', async () => {
    await mount(); await navigate('Tabs', 'Account');
    await mock.context.choose(true); await flush();
    expect(mock.gatherConsent).toHaveBeenCalledOnce();
    expect(mock.setItem).toHaveBeenCalledWith('lumora:admob:consent:v1:viewer', 'true');
    expect(mock.initialize).toHaveBeenCalledOnce();
    expect(mock.createAd).toHaveBeenCalledWith('ca-app-pub-3940256099942544/1033173712', { requestNonPersonalizedAdsOnly: true });
    mock.context.browsingComplete(); expect(mock.ad.show).not.toHaveBeenCalled();
    await mock.context.choose(false); await flush();
    expect(mock.context.ready).toBe(false); expect(mock.ad.destroy).toHaveBeenCalled();
  });
  it('does not preload or show when SDK initialization finishes after entering Player', async () => {
    let resolve!: () => void;
    mock.initialize.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    mock.getItem.mockResolvedValue('true');
    await mount(); await navigate('Tabs', 'Home');
    expect(mock.initialize).toHaveBeenCalledOnce();
    await navigate('Player'); resolve(); await flush(); mock.context.browsingComplete();
    expect(mock.createAd).not.toHaveBeenCalled(); expect(mock.ad.show).not.toHaveBeenCalled();
  });
  it('late UMP completion after the privacy deadline cannot opt in or initialize ads', async () => {
    let resolve!: (info: unknown) => void;
    mock.gatherConsent.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await mount(); await navigate('Tabs', 'Account');
    const pending = mock.context.choose(true); await flush();
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    resolve({ canRequestAds: true }); await pending; await flush();
    expect(mock.context.gate.optedIn).toBe(false);
    expect(mock.setItem).not.toHaveBeenCalledWith(expect.anything(), 'true');
    expect(mock.initialize).not.toHaveBeenCalled();
  });
  it('never preloads/shows on Player entry or in background, and destroys unused inventory', async () => {
    mock.getItem.mockResolvedValue('true');
    await mount(); await navigate('Tabs', 'Home');
    expect(mock.createAd).toHaveBeenCalledOnce();
    await navigate('Player'); mock.context.browsingComplete();
    expect(mock.context.ready).toBe(false); expect(mock.ad.destroy).toHaveBeenCalled();
    expect(mock.ad.show).not.toHaveBeenCalled();
    mock.app.currentState = 'background'; mock.appCallback?.('background'); await flush();
    expect(mock.context.ready).toBe(false);
  });
  it('presents once only on the third completed safe detail-to-catalog transition, not merely on navigation', async () => {
    mock.getItem.mockResolvedValue('true');
    await mount(); await navigate('Tabs', 'Home');
    await vi.advanceTimersByTimeAsync(125_000); await flush();
    for (let n = 0; n < 3; n += 1) {
      await navigate('Title', undefined, `detail-${n}`);
      await vi.advanceTimersByTimeAsync(10_000); await flush();
      await navigate('Tabs', 'Home');
      expect(mock.context.ready).toBe(true);
      expect(mock.ad.show).not.toHaveBeenCalled();
      mock.context.browsingComplete();
      if (n < 2) expect(mock.ad.show).not.toHaveBeenCalled();
    }
    expect(mock.ad.show).toHaveBeenCalledOnce();
    mock.context.browsingComplete(); expect(mock.ad.show).toHaveBeenCalledOnce();
  });
  it('mounts the bounded inline banner only on eligible Home, never Title or Player', async () => {
    mock.getItem.mockResolvedValue('true');
    await mount(); await navigate('Tabs', 'Home');
    const bannerIndex = mock.hooks.length;
    mock.cursor = bannerIndex;
    const banner = HomeAdMobBanner();
    expect(banner.props.children[1].props).toMatchObject({ unitId: 'ca-app-pub-3940256099942544/9214589741',
      size: 'INLINE', maxHeight: 120, requestOptions: { requestNonPersonalizedAdsOnly: true } });
    mock.focused = false; mock.cursor = bannerIndex; expect(HomeAdMobBanner()).toBeNull(); mock.focused = true;
    await navigate('Title'); mock.cursor = bannerIndex; expect(HomeAdMobBanner()).toBeNull();
    await navigate('Player'); mock.cursor = bannerIndex; expect(HomeAdMobBanner()).toBeNull();
  });
  it('invalidates pending initialization on matching blur and never publishes its late completion', async () => {
    let resolve!: () => void;
    mock.initialize.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    mock.getItem.mockResolvedValue('true');
    await mount(); await navigate('Tabs', 'Home');
    mock.context.blur('Tabs'); await flush(); resolve(); await flush();
    expect(mock.context.gate.route).toBeNull();
    expect(mock.createAd).not.toHaveBeenCalled(); expect(mock.ad.show).not.toHaveBeenCalled();
  });
  it('destroys loaded inventory synchronously on matching screen blur', async () => {
    mock.getItem.mockResolvedValue('true');
    await mount(); await navigate('Tabs', 'Home');
    mock.ad.destroy.mockClear();
    mock.context.blur('Tabs');
    expect(mock.ad.destroy).toHaveBeenCalledOnce();
    await flush(); mock.context.browsingComplete();
    expect(mock.context.ready).toBe(false); expect(mock.ad.show).not.toHaveBeenCalled();
  });
  it('ignores a Google consent form completing after the Account screen has blurred', async () => {
    let resolve!: (value: unknown) => void;
    mock.gatherConsent.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await mount(); await navigate('Tabs', 'Account');
    const pending = mock.context.choose(true); await flush();
    mock.context.blur('Tabs'); await flush();
    resolve({ canRequestAds: true }); await pending; await flush();
    expect(mock.setItem).not.toHaveBeenCalledWith(expect.anything(), 'true');
    expect(mock.context.gate.optedIn).toBe(false); expect(mock.initialize).not.toHaveBeenCalled();
  });
  it('destroys showing inventory on background, not only unused preloads', async () => {
    mock.getItem.mockResolvedValue('true');
    await mount(); await navigate('Tabs', 'Home');
    await vi.advanceTimersByTimeAsync(125_000); await flush();
    for (let n = 0; n < 3; n += 1) {
      await navigate('Title', undefined, `detail-${n}`);
      await vi.advanceTimersByTimeAsync(10_000); await flush();
      await navigate('Tabs', 'Home'); mock.context.browsingComplete();
    }
    expect(mock.ad.show).toHaveBeenCalledOnce();
    mock.ad.destroy.mockClear();
    mock.app.currentState = 'background'; mock.appCallback?.('background'); await flush();
    expect(mock.ad.destroy).toHaveBeenCalledOnce();
    expect(mock.context.ready).toBe(false);
  });
  it('destroys on account switch and rejects an old consent result without applying it to another account', async () => {
    let resolve!: (value: unknown) => void;
    mock.gatherConsent.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await mount(); await navigate('Tabs', 'Account');
    const pending = mock.context.choose(true); await flush();
    mock.profile = { accountId: 'account-b', entitlements: { resolved: true, adFree: true, status: 'active', maxProfiles: 1 } };
    mock.authCallback?.('SIGNED_IN', { user: { id: 'account-b' } });
    await vi.advanceTimersByTimeAsync(0); await flush();
    resolve({ canRequestAds: true }); await pending; await flush();
    expect(mock.context.gate.accountId).toBe('account-b');
    expect(mock.context.ready).toBe(false);
    expect(mock.setItem).not.toHaveBeenCalledWith(expect.anything(), 'true');
    expect(mock.initialize).not.toHaveBeenCalled();
  });
  it('destroys loaded inventory on auth change and ignores disposed close callbacks', async () => {
    mock.getItem.mockResolvedValue('true');
    await mount(); await navigate('Tabs', 'Home');
    const closed = mock.ad.addAdEventListener.mock.calls.find(([event]) => event === 'closed')![1];
    mock.ad.destroy.mockClear();
    mock.profile = { accountId: 'account-b', entitlements: { resolved: true, adFree: true, status: 'active', maxProfiles: 1 } };
    mock.authCallback?.('SIGNED_IN', { user: { id: 'account-b' } });
    expect(mock.ad.destroy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0); await flush();
    const requests = mock.fetchProfile.mock.calls.length;
    closed(); await flush();
    expect(mock.fetchProfile).toHaveBeenCalledTimes(requests);
    expect(mock.context.gate.accountId).toBe('account-b');
    expect(mock.context.ready).toBe(false);
  });
  it('rejects an account-A profile returned by a lookup started after a known account-B auth event', async () => {
    mock.getItem.mockResolvedValue('true');
    await mount(); await navigate('Tabs', 'Home');
    mock.authCallback?.('SIGNED_IN', { user: { id: 'account-b' } });
    await vi.advanceTimersByTimeAsync(0); await flush();
    expect(mock.context.gate.accountId).toBeNull();
    expect(mock.context.ready).toBe(false);
    expect(mock.createAd).toHaveBeenCalledOnce();
  });
  it('serializes withdrawal after a pending opt-in write so stored consent cannot revert to true', async () => {
    let resolve!: () => void;
    mock.setItem.mockImplementation((_key, value) => value === 'true' ? new Promise<void>((done) => { resolve = done; }) : Promise.resolve());
    await mount(); await navigate('Tabs', 'Account');
    const allow = mock.context.choose(true); await flush();
    const decline = mock.context.choose(false); await flush();
    expect(mock.context.ready).toBe(false);
    resolve(); await allow; await decline; await flush();
    expect(mock.setItem.mock.calls.map(([, value]) => value)).toEqual(['true', 'false']);
    expect(mock.context.gate.optedIn).toBe(false); expect(mock.initialize).not.toHaveBeenCalled();
  });
  it('ignores a stale blur for the previous screen after a newer route has already focused', async () => {
    mock.getItem.mockResolvedValue('true');
    await mount(); await navigate('Tabs', 'Home'); await navigate('Title', undefined, 'new-title');
    const count = mock.ad.destroy.mock.calls.length;
    mock.context.blur('Tabs'); await flush();
    expect(mock.context.gate.route.key).toBe('new-title');
    expect(mock.ad.destroy).toHaveBeenCalledTimes(count);
  });
});
