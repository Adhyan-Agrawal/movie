import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing, type } from '../theme';
import { Button, EmptyState, Loading, Screen } from '../components/ui';
import { Row } from '../components/Row';
import { currentUser, fetchContinueWatching, signOut, submitTitleRequest } from '../lib/api';
import { readGuestEntries } from '../lib/guest';
import { supabase } from '../lib/supabase';
import type { ContinueEntry, TitleType } from '../lib/types';
import type { RootStackParamList } from '../navigation';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * Account hub: who you're signed in as, Continue Watching, title requests.
 *
 * Continue Watching has two sources by design — signed-in viewers read the
 * server-side watch_progress rows (RLS-scoped to their profile), while guests
 * read the device-local store from `guest.ts`. Both are rendered through the
 * same `Row` so the shelf looks identical; the guest variant just carries an
 * explanatory line and never leaks another account's history.
 */
export default function AccountScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  // `signedIn === null` means "still resolving the session" — distinct from
  // signed out, so we don't flash the guest UI at a signed-in viewer.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [entries, setEntries] = useState<ContinueEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const user = await currentUser();
    setSignedIn(Boolean(user));
    setEmail(user?.email ?? null);
    setEntries(user ? await fetchContinueWatching() : await readGuestEntries());
  }, []);

  // Refresh whenever the tab is focused (e.g. returning from the Auth screen).
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // And live, when the session changes while the tab is already on screen.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(() => {
      void load();
    });
    return () => data.subscription.unsubscribe();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  async function handleSignOut() {
    await signOut();
    await load();
  }

  function playEntry(entry: ContinueEntry) {
    const t = entry.title;
    navigation.navigate('Player', {
      titleId: t.id,
      type: t.type,
      slug: t.slug,
      name: t.name,
      ...(t.tmdbId ? { tmdbId: t.tmdbId } : {}),
      ...(t.imdbId ? { imdbId: t.imdbId } : {}),
      // Series entries resume the exact episode; movies pass title params only.
      ...(entry.seasonNumber !== undefined ? { season: entry.seasonNumber } : {}),
      ...(entry.episodeNumber !== undefined ? { episode: entry.episodeNumber } : {}),
      ...(entry.episodeId ? { episodeId: entry.episodeId } : {}),
    });
  }

  const progressById: Record<string, number | undefined> = {};
  for (const e of entries) progressById[e.title.id] = e.progress;

  if (signedIn === null) {
    return (
      <Screen>
        <Loading label="Loading your account…" />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.contentMuted} />
        }
      >
        <Text style={[styles.screenTitle, { paddingTop: insets.top + spacing(5) }]}>Account</Text>

        <View style={styles.pad}>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>{signedIn ? 'Signed in as' : 'Browsing as guest'}</Text>
            <Text style={styles.cardValue} numberOfLines={1}>
              {signedIn ? email ?? 'Unknown account' : 'Not signed in'}
            </Text>
            {signedIn ? (
              <Button label="Sign out" variant="secondary" size="sm" onPress={handleSignOut} />
            ) : (
              <Button label="Sign in" size="sm" onPress={() => navigation.navigate('Auth')} />
            )}
          </View>
        </View>

        {entries.length > 0 ? (
          <Row
            heading="Continue watching"
            {...(signedIn
              ? {}
              : { reason: 'Saved on this device only — sign in to keep it across devices.' })}
            titles={entries.map((e) => e.title)}
            onPressTitle={(t) => {
              const entry = entries.find((e) => e.title.id === t.id);
              if (entry) playEntry(entry);
            }}
            progressById={progressById}
          />
        ) : (
          <View style={[styles.pad, styles.emptyWrap]}>
            <EmptyState
              title="Nothing to resume"
              description={
                signedIn
                  ? 'Titles you start watching will appear here with a resume bar.'
                  : 'Titles you watch on this device will appear here.'
              }
            />
          </View>
        )}

        <View style={styles.pad}>
          <RequestTitleCard signedIn={signedIn} onSignIn={() => navigation.navigate('Auth')} />
        </View>
      </ScrollView>
    </Screen>
  );
}

/**
 * "Request a title" form. Requests are RLS-scoped to the signed-in account, so
 * signed-out visitors get a sign-in prompt instead of a form that would fail.
 * The server's own success/error message is surfaced verbatim.
 */
function RequestTitleCard({ signedIn, onSignIn }: { signedIn: boolean; onSignIn: () => void }) {
  const [name, setName] = useState('');
  const [mediaType, setMediaType] = useState<TitleType>('movie');
  const [year, setYear] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const parsedYear = Number.parseInt(year.trim(), 10);
  const yearValid = year.trim() === '' || (Number.isFinite(parsedYear) && parsedYear > 1900 && parsedYear < 2100);
  const canSubmit = name.trim().length > 0 && yearValid && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await submitTitleRequest({
        titleName: name.trim(),
        mediaType,
        ...(year.trim() ? { year: parsedYear } : {}),
      });
      if (res.ok) {
        setResult({ ok: true, text: `Request received for "${name.trim()}". Thanks — we'll take a look.` });
        setName('');
        setYear('');
      } else {
        setResult({ ok: false, text: res.message ?? 'Request failed. Please try again.' });
      }
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : 'Network error — please try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Request a title</Text>
      {signedIn ? (
        <>
          <Text style={styles.cardHint}>Can't find something? Tell us what to add.</Text>

          <TextInput
            value={name}
            onChangeText={setName}
            style={styles.input}
            placeholder="Title name"
            placeholderTextColor={colors.contentSubtle}
            accessibilityLabel="Requested title name"
            editable={!busy}
          />

          <View style={styles.segment} accessibilityRole="radiogroup">
            <SegmentOption
              label="Movie"
              selected={mediaType === 'movie'}
              onPress={() => setMediaType('movie')}
              disabled={busy}
            />
            <SegmentOption
              label="Series"
              selected={mediaType === 'tv'}
              onPress={() => setMediaType('tv')}
              disabled={busy}
            />
          </View>

          <TextInput
            value={year}
            onChangeText={setYear}
            style={styles.input}
            placeholder="Year (optional)"
            placeholderTextColor={colors.contentSubtle}
            keyboardType="number-pad"
            accessibilityLabel="Release year, optional"
            editable={!busy}
          />

          {!yearValid ? <Text style={styles.error}>Enter a four-digit year, or leave it blank.</Text> : null}

          {result ? (
            <Text style={[styles.resultText, { color: result.ok ? colors.success : colors.danger }]} accessibilityRole="alert">
              {result.text}
            </Text>
          ) : null}

          <Button
            label="Submit request"
            variant="secondary"
            onPress={submit}
            disabled={!canSubmit}
            loading={busy}
          />
        </>
      ) : (
        <>
          <Text style={styles.cardHint}>Sign in to request a title — requests are tied to your account.</Text>
          <Button label="Sign in" variant="secondary" onPress={onSignIn} />
        </>
      )}
    </View>
  );
}

/** One half of the movie/series toggle. */
function SegmentOption({
  label,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[styles.segmentOption, selected ? styles.segmentOptionActive : null]}
    >
      <Text style={[styles.segmentLabel, selected ? styles.segmentLabelActive : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing(12) },
  screenTitle: { ...type.h1, color: colors.content, paddingHorizontal: spacing(4), marginBottom: spacing(4) },
  pad: { paddingHorizontal: spacing(4), marginBottom: spacing(6) },
  emptyWrap: { marginTop: spacing(2) },
  card: {
    padding: spacing(4),
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing(3),
  },
  cardLabel: { ...type.tiny, color: colors.contentSubtle, textTransform: 'uppercase', letterSpacing: 0.5 },
  cardTitle: { ...type.h2, color: colors.content },
  cardValue: { ...type.h3, color: colors.content },
  cardHint: { ...type.small, color: colors.contentMuted },
  input: {
    height: 46,
    paddingHorizontal: spacing(3),
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    color: colors.content,
    fontSize: 15,
  },
  segment: { flexDirection: 'row', gap: spacing(2) },
  segmentOption: {
    flex: 1,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  segmentOptionActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  segmentLabel: { ...type.body, color: colors.contentMuted, fontWeight: '600' },
  segmentLabelActive: { color: colors.primaryContrast },
  error: { ...type.small, color: colors.danger },
  resultText: { ...type.small },
});
