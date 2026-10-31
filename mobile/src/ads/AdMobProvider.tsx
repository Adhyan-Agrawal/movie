import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIsFocused } from '@react-navigation/native';
import mobileAds, { AdEventType, AdsConsent, AdsConsentPrivacyOptionsRequirementStatus, BannerAd, BannerAdSize, InterstitialAd } from 'react-native-google-mobile-ads';
import { resolveAdMobConfig } from '../../admob.config';
import { supabase } from '../lib/supabase';
import { Button } from '../components/ui';
import { colors, radius, spacing } from '../theme';
import { fetchAdMobEntitlements } from './entitlements';
import { adMobAccountEligible, canUseAdMob, createAdMobBrowsingSchedule, type AdMobGate, type AdMobRoute } from './policy';

const config = resolveAdMobConfig({ appId: process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID,
  bannerId: process.env.EXPO_PUBLIC_ADMOB_ANDROID_BANNER_ID, interstitialId: process.env.EXPO_PUBLIC_ADMOB_ANDROID_INTERSTITIAL_ID,
  testAds: process.env.EXPO_PUBLIC_ADMOB_TEST_ADS, development: __DEV__ });
const consentKey = (id: string) => `lumora:admob:consent:v1:${id}`;
const emptyGate = (): AdMobGate => ({ optedIn: false, umpEligible: false, accountId: null, entitlements: null,
  checkedAt: 0, foreground: AppState.currentState === 'active', route: null });
const requestOptions = { requestNonPersonalizedAdsOnly: true };
type Inventory = { ad: InterstitialAd; showing: boolean; dispose: () => void };
const Context = createContext<{
  gate: AdMobGate; ready: boolean; busy: boolean; message: string; privacyRequired: boolean;
  choose: (allowed: boolean) => void; privacyOptions: () => void;
  navigation: (route: AdMobRoute) => void; blur: (key: string) => void; browsingComplete: () => void;
} | null>(null);

export function AdMobProvider({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState(emptyGate);
  const gateRef = useRef(gate);
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState('Google ads are off unless you explicitly opt in.');
  const [privacyRequired, setPrivacyRequired] = useState(false);
  const [warm, setWarm] = useState(0);
  const init = useRef<Promise<unknown> | null>(null);
  const epoch = useRef(0);
  const privacySequence = useRef(0);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const authIdentity = useRef<string | null | undefined>(undefined);
  const inventory = useRef<Inventory | null>(null);
  const schedule = useRef(createAdMobBrowsingSchedule(Date.now()));
  const pending = useRef(false);
  const consentWrites = useRef<Promise<void>>(Promise.resolve());

  function update(patch: Partial<AdMobGate>) {
    gateRef.current = { ...gateRef.current, ...patch };
    if (alive.current) setGate(gateRef.current);
  }
  function discard() {
    pending.current = false;
    const previous = inventory.current;
    inventory.current = null;
    previous?.dispose();
  }
  function cancelRequests() {
    epoch.current += 1; request.current?.abort();
    privacySequence.current += 1; busyRef.current = false;
    if (alive.current) setBusy(false);
    discard();
  }
  function saveChoice(accountId: string, allowed: boolean, id: number) {
    const write = consentWrites.current.catch(() => {}).then(() => {
      if (allowed && id !== epoch.current) return;
      return AsyncStorage.setItem(consentKey(accountId), String(allowed));
    });
    consentWrites.current = write;
    return write;
  }
  async function refresh() {
    if (busyRef.current) return;
    const id = ++epoch.current;
    request.current?.abort(); request.current = new AbortController();
    update({ optedIn: false, umpEligible: false, accountId: null, entitlements: null, checkedAt: 0 });
    discard();
    const profile = await fetchAdMobEntitlements(request.current.signal);
    if (!alive.current || id !== epoch.current || !profile
      || (authIdentity.current !== undefined && profile.accountId !== authIdentity.current)) return;
    authIdentity.current = profile.accountId;
    let optedIn = false;
    try { optedIn = await AsyncStorage.getItem(consentKey(profile.accountId)) === 'true'; } catch { /* Fail closed. */ }
    if (!alive.current || id !== epoch.current || profile.accountId !== authIdentity.current) return;
    update({ ...profile, optedIn, checkedAt: Date.now() });
  }

  useEffect(() => {
    alive.current = true;
    void refresh();
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      authIdentity.current = session?.user.id ?? null;
      cancelRequests();
      update({ optedIn: false, umpEligible: false, accountId: null, entitlements: null, checkedAt: 0 });
      discard(); schedule.current.cancel();
      // Avoid awaiting Supabase while its auth callback holds the session lock.
      queueMicrotask(() => { if (alive.current) void refresh(); });
    });
    const app = AppState.addEventListener('change', (state) => {
      update({ foreground: state === 'active', umpEligible: false });
      pending.current = false; schedule.current.cancel();
      if (state === 'active') void refresh();
      else cancelRequests();
    });
    return () => {
      alive.current = false; epoch.current += 1; request.current?.abort();
      inventory.current?.dispose(); inventory.current = null;
      app.remove(); data.subscription.unsubscribe();
    };
    // The listeners use only live refs; auth changes must invalidate synchronously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allowedRoute = !!gate.route && ['Tabs', 'Title', 'Person'].includes(gate.route.root);
  useEffect(() => {
    if (Platform.OS !== 'android' || !allowedRoute || !gate.foreground || !gate.optedIn
      || !adMobAccountEligible(gate.accountId, gate.entitlements) || busyRef.current) return;
    let cancelled = false;
    const id = epoch.current;
    void AdsConsent.requestInfoUpdate().then((info) => {
      if (!cancelled && alive.current && id === epoch.current) {
        update({ umpEligible: info.canRequestAds === true });
        setPrivacyRequired(info.privacyOptionsRequirementStatus === AdsConsentPrivacyOptionsRequirementStatus.REQUIRED);
      }
    }).catch(() => { if (!cancelled && alive.current) update({ umpEligible: false }); });
    return () => { cancelled = true; };
  }, [allowedRoute, gate.foreground, gate.optedIn, gate.accountId, gate.entitlements, gate.checkedAt, gate.route?.root, gate.route?.key, gate.route?.tab]);

  const eligible = Platform.OS === 'android' && canUseAdMob(gate, Date.now());
  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    const id = epoch.current;
    try {
      init.current ??= mobileAds().initialize();
      void init.current.then(() => { if (!cancelled && alive.current && id === epoch.current && canUseAdMob(gateRef.current, Date.now())) setInitialized(true); })
        .catch(() => { init.current = null; if (!cancelled && alive.current) setMessage('Google ads are unavailable. Browsing and playback are unaffected.'); });
    } catch { init.current = null; }
    return () => { cancelled = true; };
  }, [eligible, gate.route?.root, gate.route?.key, gate.route?.tab]);

  useEffect(() => {
    if (!gate.accountId || !gate.optedIn || !gate.foreground || !allowedRoute) return;
    const timer = setInterval(() => { void refresh(); }, 45_000);
    return () => clearInterval(timer);
    // Refresh private entitlements before their one-minute lease expires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.accountId, gate.optedIn, gate.foreground, allowedRoute]);

  const ready = initialized && eligible;
  useEffect(() => {
    if (!ready) { discard(); return; }
    if (inventory.current) return;
    let ad: InterstitialAd;
    try { ad = InterstitialAd.createForAdRequest(config.interstitialId, requestOptions); } catch { return; }
    let disposed = false;
    const listeners: Array<() => void> = [];
    const item: Inventory = { ad, showing: false, dispose() {
      if (disposed) return; disposed = true; clearTimeout(timeout);
      listeners.forEach((unsubscribe) => unsubscribe());
      try { ad.destroy(); } catch { /* An optional ad must never crash browsing. */ }
    } };
    const timeout = setTimeout(() => { if (!ad.loaded && !item.showing) { item.dispose(); if (inventory.current === item) inventory.current = null; } }, 10_000);
    inventory.current = item;
    listeners.push(ad.addAdEventListener(AdEventType.LOADED, () => { if (!disposed) clearTimeout(timeout); }));
    listeners.push(ad.addAdEventListener(AdEventType.ERROR, () => { if (disposed) return; item.dispose(); if (inventory.current === item) inventory.current = null; }));
    listeners.push(ad.addAdEventListener(AdEventType.CLOSED, () => {
      if (disposed) return;
      item.dispose(); if (inventory.current === item) inventory.current = null;
      if (alive.current) { setWarm((value) => value + 1); void refresh(); }
    }));
    try { ad.load(); } catch { item.dispose(); inventory.current = null; }
    // Inventory callbacks read live refs; rearm only on eligible route/close changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, gate.route?.root, gate.route?.key, gate.route?.tab, warm]);

  async function choose(allowed: boolean, privacyOptions = false) {
    const accountId = gateRef.current.accountId;
    if (!accountId || Platform.OS !== 'android' || gateRef.current.route?.root !== 'Tabs'
      || gateRef.current.route.tab !== 'Account') return;
    if (allowed && busyRef.current) return;
    const id = ++epoch.current;
    const operation = ++privacySequence.current;
    request.current?.abort(); discard(); schedule.current.cancel();
    update({ optedIn: false, umpEligible: false });
    if (!allowed) {
      busyRef.current = true; setBusy(true);
      try {
        await saveChoice(accountId, false, id);
        if (alive.current && id === epoch.current) setMessage('Google ads are off. Your VAST/source choices are unchanged.');
      } catch { if (alive.current && id === epoch.current) setMessage('Google ads are off for this session; the choice could not be saved.'); }
      finally { if (operation === privacySequence.current) { busyRef.current = false; if (alive.current) setBusy(false); } }
      return;
    }
    busyRef.current = true; setBusy(true);
    const controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => {
      if (alive.current && id === epoch.current) {
        epoch.current += 1; privacySequence.current += 1; controller.abort();
        busyRef.current = false; setBusy(false);
        update({ umpEligible: false }); setMessage('Google privacy confirmation is taking too long. Ads remain off.');
      }
    }, 30_000);
    try {
      const profile = await fetchAdMobEntitlements(controller.signal);
      if (!alive.current || id !== epoch.current || profile?.accountId !== accountId
        || authIdentity.current !== accountId
        || !adMobAccountEligible(accountId, profile.entitlements)) {
        if (alive.current && id === epoch.current) setMessage('Your plan could not be confirmed as ad-supported. Google ads remain off.');
        return;
      }
      update({ ...profile, checkedAt: Date.now() });
      if (gateRef.current.route?.root !== 'Tabs' || gateRef.current.route.tab !== 'Account' || !gateRef.current.foreground) return;
      const info = privacyOptions ? await AdsConsent.showPrivacyOptionsForm() : await AdsConsent.gatherConsent();
      if (!alive.current || id !== epoch.current) return;
      await saveChoice(accountId, true, id);
      if (!alive.current || id !== epoch.current) return;
      update({ optedIn: true, umpEligible: info.canRequestAds === true });
      setPrivacyRequired(info.privacyOptionsRequirementStatus === AdsConsentPrivacyOptionsRequirementStatus.REQUIRED);
      setMessage(info.canRequestAds ? 'Google ads are allowed where your plan permits. Non-personalized requests only.' : 'Google privacy eligibility is unresolved. Ads remain off.');
    } catch { if (alive.current && id === epoch.current) setMessage('Google privacy or plan confirmation failed. Ads remain off.'); }
    finally {
      clearTimeout(timeout);
      if (operation === privacySequence.current) { busyRef.current = false; if (alive.current) setBusy(false); }
    }
  }

  function navigation(route: AdMobRoute) {
    const previous = gateRef.current.route;
    if (previous?.root !== route.root || previous.key !== route.key || previous.tab !== route.tab) cancelRequests();
    update({ route });
    pending.current = schedule.current.navigation(route, Date.now());
    if (gateRef.current.foreground && ['Tabs', 'Title', 'Person'].includes(route.root)
      && (!gateRef.current.accountId || Date.now() - gateRef.current.checkedAt >= 60_000)) void refresh();
  }
  function blur(key: string) {
    if (gateRef.current.route?.key !== key) return;
    cancelRequests();
    update({ route: null });
  }
  function browsingComplete() {
    const candidate = pending.current; pending.current = false;
    const item = inventory.current;
    if (!candidate || !item?.ad.loaded || item.showing || !canUseAdMob(gateRef.current, Date.now())
      || gateRef.current.route?.root !== 'Tabs' || !['Home', 'Search', 'MyList'].includes(gateRef.current.route.tab ?? '')) return;
    item.showing = true; schedule.current.shown(Date.now());
    try { void item.ad.show().catch(() => { item.showing = false; item.dispose(); if (inventory.current === item) inventory.current = null; }); }
    catch { item.showing = false; item.dispose(); if (inventory.current === item) inventory.current = null; }
  }

  return <Context.Provider value={{ gate, ready, busy, message, privacyRequired, choose,
    privacyOptions: () => { void choose(true, true); }, navigation, blur, browsingComplete }}>{children}</Context.Provider>;
}

export function useAdMob() {
  const value = useContext(Context);
  if (!value) throw new Error('AdMobProvider is required.');
  return value;
}

export function HomeAdMobBanner() {
  const { gate, ready } = useAdMob();
  const focused = useIsFocused();
  const { width } = useWindowDimensions();
  const [failed, setFailed] = useState(false);
  if (!focused || !ready || gate.route?.root !== 'Tabs' || gate.route.tab !== 'Home' || failed) return null;
  return <View style={styles.banner} accessibilityLabel="Advertisement">
    <Text style={styles.label}>Advertisement</Text>
    <BannerAd unitId={config.bannerId} size={BannerAdSize.INLINE_ADAPTIVE_BANNER} maxHeight={120}
      width={Math.max(1, Math.floor(width - spacing(8)))} requestOptions={requestOptions} onAdFailedToLoad={() => setFailed(true)} />
  </View>;
}

export function AdMobPrivacyChoices() {
  const { gate, busy, message, privacyRequired, choose, privacyOptions } = useAdMob();
  const eligible = adMobAccountEligible(gate.accountId, gate.entitlements);
  return <View style={styles.privacy}>
    <Text style={styles.heading}>Google Ads Privacy</Text>
    <Text style={styles.detail}>Optional Google ads may use device identifiers and measurement. This choice is separate from streaming-source and VAST permissions. Guest, ad-free, or unresolved plans receive no Google ads.</Text>
    <Text style={styles.detail} accessibilityLiveRegion="polite">{message}</Text>
    <Text style={styles.detail}>Your choice: {gate.optedIn ? 'Allowed, subject to Google privacy and plan eligibility' : 'Off'}</Text>
    <View style={styles.actions}>
      <Button label="Allow Google ads" size="sm" disabled={busy || !eligible} onPress={() => choose(true)} />
      <Button label="Keep Google ads off" size="sm" variant="secondary" disabled={!gate.accountId} onPress={() => choose(false)} />
      {privacyRequired && gate.optedIn ? <Button label="Google privacy options" size="sm" variant="secondary" disabled={busy || !eligible} onPress={privacyOptions} /> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  banner: { margin: spacing(4), paddingVertical: spacing(4), minHeight: 100, gap: spacing(2), alignItems: 'center', backgroundColor: colors.surface },
  label: { color: colors.contentSubtle, fontSize: 11, textTransform: 'uppercase' },
  privacy: { marginTop: spacing(3), padding: spacing(4), borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, gap: spacing(3) },
  heading: { color: colors.content, fontSize: 17, fontWeight: '700' },
  detail: { color: colors.contentMuted, fontSize: 13, lineHeight: 19 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
});
