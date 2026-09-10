import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { colors, radius, spacing, type } from '../theme';
import { Button, Screen } from '../components/ui';
import { signIn, signUp } from '../lib/api';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Auth'>;
type Mode = 'signin' | 'signup';

/**
 * Email + password authentication (sign in / create account) in one screen.
 *
 * The Lumora backend has email confirmation disabled, so a new account is
 * usable the instant it is created — the copy says so plainly instead of
 * sending people to an inbox that never receives a mail. Both modes land back
 * on whatever pushed Auth (`goBack`); the session itself is persisted in
 * AsyncStorage by the shared Supabase client, so no extra plumbing is needed.
 */
export default function AuthScreen({ navigation }: Props) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignUp = mode === 'signup';
  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = isSignUp ? await signUp(email, password) : await signIn(email, password);
      if (!result.ok) {
        setError(result.message ?? 'Something went wrong. Please try again.');
        return;
      }
      navigation.goBack();
    } catch (e) {
      // Network failures reject rather than returning { ok: false }.
      setError(e instanceof Error ? e.message : 'Network error — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  function toggleMode() {
    setMode(isSignUp ? 'signin' : 'signup');
    setError(null);
  }

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.heading}>{isSignUp ? 'Create your account' : 'Welcome back'}</Text>
          <Text style={styles.lede}>
            {isSignUp
              ? 'Account creation is instant — this backend requires no email confirmation step, so you can start watching straight away.'
              : 'Sign in to sync your list and pick up where you left off on any device.'}
          </Text>

          <View style={styles.field}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor={colors.contentSubtle}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              accessibilityLabel="Email address"
              editable={!busy}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              style={styles.input}
              placeholder="••••••••"
              placeholderTextColor={colors.contentSubtle}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType={isSignUp ? 'newPassword' : 'password'}
              accessibilityLabel="Password"
              editable={!busy}
              returnKeyType="go"
              onSubmitEditing={submit}
            />
          </View>

          {error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}

          <Button
            label={isSignUp ? 'Create account' : 'Sign in'}
            onPress={submit}
            size="lg"
            disabled={!canSubmit}
            loading={busy}
            style={styles.submit}
          />

          <View style={styles.toggleRow}>
            <Text style={styles.toggleCopy}>
              {isSignUp ? 'Already have an account?' : "Don't have an account yet?"}
            </Text>
            <Pressable
              onPress={toggleMode}
              disabled={busy}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={isSignUp ? 'Switch to sign in' : 'Switch to create account'}
            >
              <Text style={styles.toggleLink}>{isSignUp ? 'Sign in' : 'Create one'}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing(5), gap: spacing(4), paddingBottom: spacing(10) },
  heading: { ...type.h1, color: colors.content },
  lede: { ...type.body, color: colors.contentMuted, lineHeight: 20 },
  field: { gap: spacing(2) },
  label: { ...type.tiny, color: colors.contentMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    height: 48,
    paddingHorizontal: spacing(3),
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    color: colors.content,
    fontSize: 15,
  },
  error: { ...type.body, color: colors.danger },
  submit: { marginTop: spacing(1) },
  toggleRow: { flexDirection: 'row', gap: spacing(2), alignItems: 'center', justifyContent: 'center' },
  toggleCopy: { ...type.body, color: colors.contentMuted },
  toggleLink: { ...type.body, color: colors.primary, fontWeight: '600' },
});
