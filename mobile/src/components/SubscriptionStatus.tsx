import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../lib/supabase';
import { colors, radius, spacing } from '../theme';

interface Entitlements { resolved: boolean; adFree: boolean; maxProfiles: number; status: string; planName?: string; accessUntil?: string }

export function SubscriptionStatus() {
  const [state, setState] = useState<Entitlements | null | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) { setState(null); return; }
      const base = (process.env.EXPO_PUBLIC_WEB_URL ?? 'https://hulkofyt.eu.org').replace(/\/$/, '');
      const response = await fetch(`${base}/api/account/subscription`, {
        signal: controller.signal, headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      const body = await response.json() as { entitlements?: Entitlements };
      if (body.entitlements?.resolved) setState(body.entitlements);
      else setState(null);
    })().catch(() => { if (!controller.signal.aborted) setState(null); })
      .finally(() => { clearTimeout(timeout); if (controller.signal.aborted) setState(null); });
    return () => { controller.abort(); clearTimeout(timeout); };
  }, []);
  return <View style={styles.card}>
    <Text style={styles.label}>Your plan</Text>
    {state === undefined ? <ActivityIndicator color={colors.primary} /> : state ? <>
      <Text style={styles.name}>{state.planName ?? 'Free'}</Text>
      <Text style={styles.details}>{state.adFree ? 'No Lumora ads' : 'Ad-supported playback'} - {state.maxProfiles} profile{state.maxProfiles === 1 ? '' : 's'}</Text>
      {state.accessUntil ? <Text style={styles.details}>Access until {new Date(state.accessUntil).toLocaleDateString()}</Text> : null}
      <Text style={styles.note}>Purchases activate only through a configured, verified billing channel.</Text>
    </> : <Text style={styles.details}>Plan status is temporarily unavailable.</Text>}
  </View>;
}

const styles = StyleSheet.create({
  card: { marginTop: spacing(3), padding: spacing(4), borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: spacing(2) },
  label: { color: colors.contentMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  name: { color: colors.content, fontSize: 20, fontWeight: '700' },
  details: { color: colors.contentMuted, fontSize: 13 },
  note: { color: colors.contentMuted, fontSize: 11, lineHeight: 16 },
});
