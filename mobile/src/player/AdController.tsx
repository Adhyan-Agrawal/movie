import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Modal, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { VideoPlayer } from 'expo-video';
import { supabase } from '../lib/supabase';
import type { NativeAdPolicy, NativeVastCreative } from '../lib/types';
import { createNativeAdSchedule } from './policy';
import NativeVastAd from './VastAdBreak';

const CONSENT_KEY = 'lumora:ads:consent';

export function AdController({ player, policy }: { player: VideoPlayer; policy?: NativeAdPolicy }) {
  const [creative, setCreative] = useState<NativeVastCreative | null>(null);
  const restoreRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!policy?.enabled) { setCreative(null); return; }
    const schedule = createNativeAdSchedule(policy);
    let consent = false; let active = false; let cancelled = false; let last = Date.now();
    let restore: { position: number; rate: number; playing: boolean } | null = null;
    let request: AbortController | null = null;
    const finish = () => {
      if (!active) return;
      active = false; schedule.finish(); request?.abort();
      if (!cancelled) setCreative(null);
      if (restore) {
        try {
          player.currentTime = restore.position; player.playbackRate = restore.rate;
          if (restore.playing && AppState.currentState === 'active') player.play();
        } catch { /* Navigation may have disposed the content player. */ }
      }
      restore = null; last = Date.now();
    };
    restoreRef.current = finish;
    void AsyncStorage.getItem(CONSENT_KEY).then((stored) => {
      if (cancelled) return;
      if (stored !== null) { consent = stored === 'true'; return; }
      Alert.alert('Advertising privacy', 'Allow video advertisements and playback tracking? This is separate from permission to load a streaming provider.', [
        { text: 'Not now', style: 'cancel', onPress: () => { consent = false; void AsyncStorage.setItem(CONSENT_KEY, 'false'); } },
        { text: 'Allow', onPress: () => { consent = true; void AsyncStorage.setItem(CONSENT_KEY, 'true'); } },
      ]);
    }).catch(() => {});
    const begin = async () => {
      active = true; restore = { position: player.currentTime, rate: player.playbackRate, playing: player.playing }; player.pause();
      const controller = new AbortController(); request = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const { data } = await supabase.auth.getSession();
        const base = (process.env.EXPO_PUBLIC_WEB_URL ?? 'https://hulkofyt.eu.org').replace(/\/$/, '');
        const response = await fetch(`${base}/api/vast?consent=1`, { signal: controller.signal,
          ...(data.session ? { headers: { Authorization: `Bearer ${data.session.access_token}` } } : {}) });
        if (!response.ok || response.status === 204) { finish(); return; }
        const body = await response.json() as { creative?: NativeVastCreative };
        if (cancelled || !active) return;
        if (!body.creative?.mediaUrl || !Number.isFinite(body.creative.durationSeconds)) { finish(); return; }
        setCreative(body.creative);
      } catch { finish(); } finally { clearTimeout(timeout); }
    };
    const time = player.addListener('timeUpdate', () => {
      const now = Date.now(); const elapsed = (now - last) / 1000; last = now;
      if (consent && !active && player.playing && AppState.currentState === 'active' && schedule.advance(elapsed)) void begin();
    });
    const playing = player.addListener('playingChange', () => { last = Date.now(); });
    const app = AppState.addEventListener('change', (state) => { last = Date.now(); if (state !== 'active') finish(); });
    return () => { cancelled = true; finish(); time.remove(); playing.remove(); app.remove(); request?.abort(); restoreRef.current = () => {}; };
  }, [player, policy?.enabled, policy?.firstBreakSeconds, policy?.intervalSeconds, policy?.maxBreaks, policy?.allowSkip, policy?.skipAfterSeconds]);
  return <Modal transparent visible={Boolean(creative)} animationType="fade" onRequestClose={() => { /* Back cannot bypass an unskippable ad. */ }}>
    <View style={{ flex: 1, backgroundColor: '#06070a' }}>{creative && policy ? <NativeVastAd key={creative.id} creative={creative} policy={policy} onDone={() => restoreRef.current()} /> : null}</View>
  </Modal>;
}
