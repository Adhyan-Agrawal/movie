import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeAdPolicy, NativeVastCreative } from '../lib/types';
import { nativeAdHttpsUrl, nativeAdSkipAfter } from './policy';

export type NativeVastResult = 'complete' | 'skip' | 'error' | 'cancel';

export default function NativeVastAd({ creative, policy, volume = 1, muted = false, onDone }: {
  creative: NativeVastCreative; policy: NativeAdPolicy; volume?: number; muted?: boolean; onDone: (result: NativeVastResult) => void;
}) {
  const player = useVideoPlayer(null, (video) => {
    video.timeUpdateEventInterval = 0.25; video.staysActiveInBackground = false; video.loop = false;
    video.volume = volume; video.muted = muted;
  });
  const insets = useSafeAreaInsets();
  const [time, setTime] = useState(0);
  const [started, setStarted] = useState(false);
  const done = useRef(false);
  const hasPlayed = useRef(false);
  const callback = useRef(onDone); callback.current = onDone;
  const finishRef = useRef<(result: NativeVastResult) => void>(() => {});
  const clickRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    done.current = false;
    hasPlayed.current = false;
    // RN fetch cannot enforce redirect policy. No third-party beacons are delivered
    // until a server relay validates every hop; browser click-through is user initiated.
    const finish = (result: NativeVastResult) => {
      if (done.current) return;
      done.current = true;
      clearTimeout(stall);
      clearTimeout(limit);
      player.pause();
      callback.current(result);
    };
    finishRef.current = finish;
    clickRef.current = () => {
      const url = creative.clickThrough && nativeAdHttpsUrl(creative.clickThrough);
      if (done.current || !hasPlayed.current || !url || AppState.currentState !== 'active') return;
      void Linking.openURL(url).catch(() => {});
    };
    let stall = setTimeout(() => finish('error'), 15_000);
    const limit = setTimeout(() => finish('error'), 630_000);
    let lastTime = 0;
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => finish('error'), 15_000); };
    const playing = () => {
      if (done.current || !player.playing || player.status !== 'readyToPlay' || AppState.currentState !== 'active') return;
      if (!hasPlayed.current) { hasPlayed.current = true; setStarted(true); }
    };
    const listeners = [
      player.addListener('statusChange', ({ status }) => { if (status === 'error') finish('error'); }),
      player.addListener('playingChange', ({ isPlaying }) => {
        if (done.current || !isPlaying || player.status !== 'readyToPlay' || AppState.currentState !== 'active') return;
        playing();
      }),
      player.addListener('playToEnd', () => finish(hasPlayed.current ? 'complete' : 'error')),
      player.addListener('timeUpdate', ({ currentTime }) => {
        if (done.current || !player.playing || player.status !== 'readyToPlay'
          || AppState.currentState !== 'active' || !Number.isFinite(currentTime) || currentTime < 0) return;
        playing();
        if (currentTime > lastTime) { lastTime = currentTime; arm(); }
        setTime(currentTime);
        if (currentTime > 600) finish('error');
      }),
    ];
    const app = AppState.addEventListener('change', (state) => { if (state !== 'active') finish('cancel'); });
    void player.replaceAsync({ uri: creative.mediaUrl, contentType: 'progressive' }).then(() => {
      if (cancelled) return;
      if (!done.current && AppState.currentState === 'active') player.play();
      else if (!done.current) finish('cancel');
    }).catch(() => { if (!cancelled && !done.current) finish('error'); });
    return () => {
      cancelled = true;
      done.current = true;
      clearTimeout(stall); clearTimeout(limit);
      listeners.forEach((listener) => listener.remove()); app.remove();
      finishRef.current = () => {}; clickRef.current = () => {};
      try { player.pause(); } catch { /* The hook may already have released the native object. */ }
    };
  }, [player, creative]);
  const skip = nativeAdSkipAfter(policy, creative);
  return <View style={styles.overlay} accessibilityLabel="Advertisement">
    <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} surfaceType="textureView" contentFit="contain"
      fullscreenOptions={{ enable: false }} allowsPictureInPicture={false} requiresLinearPlayback />
    <Text style={[styles.label, { top: insets.top + 16, left: insets.left + 16 }]}>Advertisement - {Math.max(0, Math.ceil(creative.durationSeconds - time))}s</Text>
    <View style={[styles.actions, { right: insets.right + 16, bottom: insets.bottom + 16 }]}>
      {creative.clickThrough && nativeAdHttpsUrl(creative.clickThrough) ? <Pressable accessibilityRole="link" disabled={!started}
        onPress={() => clickRef.current()} style={styles.button}><Text style={styles.text}>Learn more</Text></Pressable> : null}
      {Number.isFinite(skip) ? <Pressable accessibilityRole="button" disabled={!started || time < skip}
        accessibilityState={{ disabled: !started || time < skip }} onPress={() => {
          if (hasPlayed.current && player.currentTime >= skip) finishRef.current('skip');
        }} style={styles.button}><Text style={styles.text}>{time < skip ? `Skip in ${Math.ceil(skip - time)}s` : 'Skip ad'}</Text></Pressable> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 30, backgroundColor: '#06070a' },
  label: { position: 'absolute', top: 16, left: 16, color: '#fff', backgroundColor: '#000b', padding: 8, borderRadius: 6, fontSize: 12 },
  actions: { position: 'absolute', right: 16, bottom: 16, flexDirection: 'row', gap: 8 },
  button: { padding: 14, backgroundColor: '#000d', borderRadius: 8, borderWidth: 1, borderColor: '#ffffff44' },
  text: { color: '#fff', fontSize: 13 },
});
