import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  hooks: [] as any[], cursor: 0, effects: [] as Array<() => void>, dirty: false,
  focus: null as null | (() => () => void), auth: null as null | ((event: string, session: any) => void),
  user: null as any, currentUser: vi.fn(), history: vi.fn(), guest: vi.fn(), signOut: vi.fn(), unsubscribe: vi.fn(), navigate: vi.fn(),
}));
vi.mock('../../mobile/node_modules/react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [mock.hooks[index], (next: any) => {
      const value = typeof next === 'function' ? next(mock.hooks[index]) : next;
      if (value !== mock.hooks[index]) { mock.hooks[index] = value; mock.dirty = true; }
    }];
  },
  useRef: (initial: any) => { const index = mock.cursor++; return mock.hooks[index] ??= { current: initial }; },
  useCallback: (callback: any, deps: any[]) => {
    const index = mock.cursor++;
    const previous = mock.hooks[index];
    if (!previous || deps.some((dep, n) => dep !== previous.deps[n])) mock.hooks[index] = { deps, callback };
    return mock.hooks[index].callback;
  },
  useEffect: (effect: () => any, deps: any[]) => {
    const index = mock.cursor++;
    const previous = mock.hooks[index];
    if (!previous || deps.some((dep, n) => dep !== previous.deps[n])) {
      mock.hooks[index] = { deps, cleanup: previous?.cleanup };
      mock.effects.push(() => { previous?.cleanup?.(); mock.hooks[index].cleanup = effect(); });
    }
  },
}));
vi.mock('../../mobile/node_modules/react-native', () => ({ Pressable: 'Pressable', RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View', StyleSheet: { create: (value: any) => value } }));
vi.mock('../../mobile/node_modules/@react-navigation/native/lib/module/index.js', () => ({
  useNavigation: () => ({ navigate: mock.navigate }), useFocusEffect: (callback: typeof mock.focus) => { mock.focus = callback; },
}));
vi.mock('../../mobile/node_modules/react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('../../mobile/src/components/ui', () => ({ Button: 'Button', EmptyState: 'EmptyState', Loading: 'Loading', Screen: 'Screen' }));
vi.mock('../../mobile/src/components/Row', () => ({ Row: 'Row' }));
vi.mock('../../mobile/src/components/SubscriptionStatus', () => ({ SubscriptionStatus: 'SubscriptionStatus' }));
vi.mock('../../mobile/src/ads/AdMobProvider', () => ({ AdMobPrivacyChoices: 'AdMobPrivacyChoices' }));
vi.mock('../../mobile/src/lib/api', () => ({ currentUser: mock.currentUser, fetchContinueWatching: mock.history,
  signOut: mock.signOut, getTitleBySlug: vi.fn(), submitTitleRequest: vi.fn() }));
vi.mock('../../mobile/src/lib/guest', () => ({ readGuestEntries: mock.guest }));
vi.mock('../../mobile/src/lib/supabase', () => ({ supabase: { auth: { onAuthStateChange: (callback: typeof mock.auth) => {
  mock.auth = callback; return { data: { subscription: { unsubscribe: mock.unsubscribe } } };
} } } }));
const componentPath = '../../mobile/src/screens/AccountScreen';
const { default: AccountScreen } = await import(componentPath);

const accountA = { id: 'account-a', email: 'a@example.test' };
const accountB = { id: 'account-b', email: 'b@example.test' };
const row = (id: string) => ({ title: { id, name: id, slug: id, type: 'movie', tmdbId: '1' }, progress: 20 });
let tree: any;
let blur: (() => void) | undefined;
function render() {
  mock.cursor = 0; mock.dirty = false; tree = AccountScreen();
  mock.effects.splice(0).forEach((effect) => effect());
}
async function flush() {
  for (let n = 0; n < 20; n += 1) { await Promise.resolve(); if (mock.dirty) render(); }
}
async function mount() { render(); blur = mock.focus!(); await flush(); }
function find(type: string, node: any = tree): any {
  if (Array.isArray(node)) return node.map((item) => find(type, item ?? null)).find(Boolean) ?? null;
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  return find(type, node.props?.children ?? null);
}
const serialized = () => JSON.stringify(tree);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function changeAccount(user: any) {
  mock.user = user; mock.auth!('SIGNED_IN', user ? { user } : null);
  render(); await vi.advanceTimersByTimeAsync(0); await flush();
}

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mock.hooks = []; mock.effects = []; mock.cursor = 0; mock.dirty = false; mock.user = accountA;
  mock.currentUser.mockImplementation(async () => mock.user);
  mock.history.mockImplementation(async () => [row(`history-${mock.user.id}`)]);
  mock.guest.mockResolvedValue([row('guest-device-history')]);
  mock.signOut.mockImplementation(async () => { mock.user = null; });
});
afterEach(() => { blur?.(); blur = undefined; mock.hooks.forEach((hook) => hook?.cleanup?.()); vi.useRealTimers(); });

describe('Account identity and request-generation regressions', () => {
  it('cannot publish a delayed account-A identity response after account-B has loaded', async () => {
    const delayed = deferred<any>(); mock.currentUser.mockImplementationOnce(() => delayed.promise);
    await mount(); await changeAccount(accountB);
    expect(serialized()).toContain(accountB.email);
    delayed.resolve(accountA); await flush();
    expect(serialized()).toContain(accountB.email);
    expect(serialized()).not.toContain(accountA.email);
    expect(find('Row').props.titles[0].id).toBe('history-account-b');
  });
  it('clears A email/history synchronously and rejects A rows completing after an auth switch', async () => {
    await mount(); expect(serialized()).toContain(accountA.email);
    const delayed = deferred<any[]>(); mock.history.mockImplementationOnce(() => delayed.promise);
    const refresh = find('ScrollView').props.refreshControl.props.onRefresh(); await flush();
    mock.user = accountB; mock.auth!('SIGNED_IN', { user: accountB }); render();
    expect(serialized()).not.toContain(accountA.email);
    expect(serialized()).not.toContain('history-account-a');
    await vi.advanceTimersByTimeAsync(0); await flush();
    delayed.resolve([row('private-history-a')]); await refresh; await flush();
    expect(serialized()).toContain(accountB.email);
    expect(serialized()).not.toContain('private-history-a');
  });
  it('never pairs A identity with rows fetched under B when identity changes during the library read', async () => {
    const delayed = deferred<any[]>(); mock.history.mockImplementationOnce(() => delayed.promise);
    await mount(); mock.user = accountB; delayed.resolve([row('history-account-b')]); await flush();
    expect(find('Row')).toBeNull(); expect(serialized()).not.toContain(accountA.email);
  });
  it('ignores an auth lookup returning old A for an already captured B session', async () => {
    await mount(); mock.user = accountB;
    mock.currentUser.mockResolvedValueOnce(accountA);
    mock.auth!('SIGNED_IN', { user: accountB }); render(); await vi.advanceTimersByTimeAsync(0); await flush();
    expect(find('Row')).toBeNull(); expect(serialized()).not.toContain(accountA.email);
  });
  it('cannot publish a pending history response after blur or unmount', async () => {
    const delayed = deferred<any[]>(); mock.history.mockImplementationOnce(() => delayed.promise);
    await mount(); blur?.(); blur = undefined;
    mock.hooks.forEach((hook) => hook?.cleanup?.());
    const snapshot = serialized(); mock.dirty = false;
    delayed.resolve([row('private-late-history')]); await flush();
    expect(serialized()).toBe(snapshot); expect(mock.dirty).toBe(false);
    expect(mock.unsubscribe).toHaveBeenCalled();
  });
  it('preserves sign-out/guest behavior while never showing the previous account history', async () => {
    await mount();
    const card = find('SubscriptionStatus'); expect(card).not.toBeNull();
    const button = (function locate(node: any): any {
      if (Array.isArray(node)) return node.map(locate).find(Boolean);
      if (!node || typeof node !== 'object') return null;
      if (node.type === 'Button' && node.props.label === 'Sign out') return node;
      return locate(node.props?.children);
    })(tree);
    const pending = button.props.onPress(); render();
    expect(serialized()).not.toContain(accountA.email);
    await pending; await flush();
    expect(mock.signOut).toHaveBeenCalledOnce();
    expect(serialized()).toContain('Browsing as guest');
    expect(find('Row').props.titles[0].id).toBe('guest-device-history');
  });
  it('defers auth/library reads outside the Supabase auth callback lock', async () => {
    await mount(); mock.currentUser.mockClear();
    mock.user = accountB; mock.auth!('SIGNED_IN', { user: accountB });
    expect(mock.currentUser).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0); await flush();
    expect(mock.currentUser).toHaveBeenCalled();
    expect(serialized()).toContain(accountB.email);
  });
});
