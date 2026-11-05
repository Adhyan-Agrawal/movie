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
import { AUTH_UNAVAILABLE_MESSAGE, isAuthConfigured, signIn, signUp } from '../lib/api';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Auth'>;
type Mode = 'signin' | 'signup';

/** Return to the caller only after Supabase establishes a native session. */
export default function AuthScreen({ navigation }: Props) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignUp = mode === 'signup';
  const authAvailable = isAuthConfigured();
  const canSubmit = authAvailable && email.trim().length > 0 && password.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (isSignUp) {
        const result = await signUp(email, password);
        if (result.status !== 'signedIn') {
          if (result.status === 'verificationRequired') {
            setNotice(result.message);
            setMode('signin');
          } else setError(result.message);
          return;
        }
      } else {
        const result = await signIn(email, password);
        if (!result.ok) {
          setError(result.message ?? 'Something went wrong. Please try again.');
          return;
        }
      }
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  function toggleMode() {
    if (!authAvailable || busy) return;
    setMode(isSignUp ? 'signin' : 'signup');
    setError(null);
    setNotice(null);
  }

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.heading}>{isSignUp ? 'Create your account' : 'Welcome back'}</Text>
          <Text style={styles.lede}>
            {isSignUp
              ? 'Create an account. Email verification may be required before you can sign in.'
              : 'Sign in to access your account\'s saved list and watch history.'}
          </Text>
          {!authAvailable ? <Text style={styles.lede} accessibilityRole="alert">{AUTH_UNAVAILABLE_MESSAGE}</Text> : null}

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
              editable={authAvailable && !busy}
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
              editable={authAvailable && !busy}
              returnKeyType="go"
              onSubmitEditing={submit}
            />
          </View>

          {error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          {notice ? <Text style={styles.lede} accessibilityLiveRegion="polite">{notice}</Text> : null}

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
              disabled={!authAvailable || busy}
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
