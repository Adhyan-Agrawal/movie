import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { NativeAdPolicy, NativeVastCreative } from '../lib/types';

export default function NativeVastAd({ creative, policy, onDone }: { creative: NativeVastCreative; policy: NativeAdPolicy; onDone: () => void }) {
  const player = useVideoPlayer({ uri: creative.mediaUrl, contentType: 'progressive' }, (video) => {
    video.timeUpdateEventInterval = 0.25; video.staysActiveInBackground = false; video.loop = false;
  });
  const [time, setTime] = useState(0);
  const done = useRef(false);
  const callback = useRef(onDone); callback.current = onDone;
  const sent = useRef(new Set<string>());
  const track = (event: keyof NativeVastCreative['tracking']) => {
    if (sent.current.has(event)) return;
    sent.current.add(event);
    for (const raw of creative.tracking[event] ?? []) {
      try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.username || url.password) continue;
        void fetch(url.href.replace(/(?:\[CACHEBUSTING\]|%5BCACHEBUSTING%5D)/gi, String(Date.now())).replace(/(?:\[ERRORCODE\]|%5BERRORCODE%5D)/gi, '405'), { method: 'GET' }).catch(() => {});
      } catch { /* Failed tracking never blocks content. */ }
    }
  };
  const finish = (event: 'complete' | 'skip' | 'error') => {
    if (done.current) return;
    done.current = true; track(event); player.pause(); callback.current();
  };
  useEffect(() => {
    let timeout = setTimeout(() => finish('error'), 15_000);
    const arm = () => { clearTimeout(timeout); timeout = setTimeout(() => finish('error'), 15_000); };
    const listeners = [
      player.addListener('statusChange', ({ status }) => { if (status === 'error') finish('error'); }),
      player.addListener('playingChange', ({ isPlaying }) => { if (isPlaying) { arm(); track('impression'); track('start'); } }),
      player.addListener('statusChange', ({ status }) => { if (status === 'loading') arm(); }),
      player.addListener('playToEnd', () => finish('complete')),
      player.addListener('timeUpdate', ({ currentTime }) => {
        setTime(currentTime);
        if (currentTime >= creative.durationSeconds * 0.25) track('firstQuartile');
        if (currentTime >= creative.durationSeconds * 0.5) track('midpoint');
        if (currentTime >= creative.durationSeconds * 0.75) track('thirdQuartile');
        if (currentTime > 600) finish('error');
      }),
    ];
    const app = AppState.addEventListener('change', (state) => { if (state !== 'active') finish('error'); });
    player.play();
    return () => { clearTimeout(timeout); listeners.forEach((listener) => listener.remove()); app.remove(); player.pause(); };
    // Break-local player and callbacks are intentionally mounted once per creative.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const skip = policy.allowSkip && creative.skipAfterSeconds !== null ? Math.max(policy.skipAfterSeconds, creative.skipAfterSeconds) : Infinity;
  return <View style={styles.overlay} accessibilityLabel="Advertisement">
    <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} surfaceType="textureView" contentFit="contain" />
    <Text style={styles.label}>Advertisement - {Math.max(0, Math.ceil(creative.durationSeconds - time))}s</Text>
    <View style={styles.actions}>
      {creative.clickThrough ? <Pressable accessibilityRole="link" onPress={() => {
        for (const raw of creative.clickTracking ?? []) { try { const url = new URL(raw); if (url.protocol === 'https:' && !url.username && !url.password) void fetch(url.href).catch(() => {}); } catch { /* Invalid tracking is ignored. */ } }
        void Linking.openURL(creative.clickThrough!);
      }} style={styles.button}><Text style={styles.text}>Learn more</Text></Pressable> : null}
      {Number.isFinite(skip) ? <Pressable accessibilityRole="button" disabled={time < skip} onPress={() => finish('skip')} style={styles.button}><Text style={styles.text}>{time < skip ? `Skip in ${Math.ceil(skip - time)}s` : 'Skip ad'}</Text></Pressable> : null}
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
