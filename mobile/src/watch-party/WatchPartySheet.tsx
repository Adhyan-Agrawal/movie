import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '../components/ui';
import { colors } from '../theme';
import { WATCH_PARTY_SERVICE_AVAILABLE, WATCH_PARTY_UNAVAILABLE_MESSAGE } from './config';
import { WATCH_PARTY_LIMITS, normalizeWatchPartyRoomCode } from './protocol';
import type { WatchPartySessionController, WatchPartySyncStatus } from './useWatchPartySession';

interface WatchPartySheetProps {
  open: boolean;
  onClose: () => void;
  session: WatchPartySessionController;
  initialRoomCode?: string;
}

function syncCopy(status: WatchPartySyncStatus): string {
  if (status === 'chat-only-embed') return 'Chat only. External WebView players do not expose safe playback synchronization.';
  if (status === 'chat-only-unavailable') return 'Chat only. A native playback source is not available.';
  if (status === 'unsupported-media') return 'Chat is available, but this title has no stable v1 media identity.';
  if (status === 'different-media') return 'Chat only. This room is watching a different title or episode.';
  if (status === 'awaiting-player-port') return 'Chat is ready. Waiting for the native player connection.';
  if (status === 'player-port-error') return 'Chat is connected, but playback synchronization failed locally.';
  if (status === 'local-blocked') return 'Playback synchronization is waiting for the local source to become ready.';
  return 'Native playback synchronization is active.';
}

function connectionLabel(session: WatchPartySessionController): string {
  if (!WATCH_PARTY_SERVICE_AVAILABLE) return 'Unavailable';
  const { phase, reconnectAttempt } = session.state;
  if (phase === 'ticketing') return 'Getting secure ticket';
  if (phase === 'connecting') return 'Connecting';
  if (phase === 'reconnecting') return `Reconnecting ${reconnectAttempt}`;
  if (phase === 'connected') return 'Connected';
  if (phase === 'closed') return 'Room closed';
  if (phase === 'error') return 'Connection stopped';
  return 'Not connected';
}

export default function WatchPartySheet({ open, onClose, session, initialRoomCode }: WatchPartySheetProps) {
  const insets = useSafeAreaInsets();
  const [displayName, setDisplayName] = useState('');
  const [roomCode, setRoomCode] = useState(initialRoomCode ?? '');
  const [chatText, setChatText] = useState('');
  const [formError, setFormError] = useState('');
  const [shareStatus, setShareStatus] = useState('');

  useEffect(() => { if (initialRoomCode) setRoomCode(initialRoomCode); }, [initialRoomCode]);

  const { state } = session;
  const hasRoom = WATCH_PARTY_SERVICE_AVAILABLE && Boolean(state.room && state.self);
  const connected = WATCH_PARTY_SERVICE_AVAILABLE && state.phase === 'connected';
  const connectedCount = state.participants.filter((participant) => participant.connected).length;
  const rateLimited = state.rateLimitedUntilMs !== null && state.rateLimitedUntilMs > Date.now();

  function createRoom() {
    if (!WATCH_PARTY_SERVICE_AVAILABLE) return;
    setFormError('');
    if (!session.create(displayName)) setFormError('Enter a display name before creating a room.');
  }

  function joinRoom() {
    if (!WATCH_PARTY_SERVICE_AVAILABLE) return;
    setFormError('');
    const normalized = normalizeWatchPartyRoomCode(roomCode);
    if (!normalized || !session.join(displayName, normalized)) {
      setFormError('Enter a name and valid 10-character room code.');
      return;
    }
    setRoomCode(normalized);
  }

  function sendChat() {
    if (!session.sendChat(chatText)) return;
    setChatText('');
  }

  async function shareInvite() {
    const value = session.inviteUrl ?? state.room?.roomCode;
    if (!value) return;
    try {
      const appLink = session.appInviteUrl && session.appInviteUrl !== value ? `\nOpen in Lumora: ${session.appInviteUrl}` : '';
      await Share.share({ title: 'Join my Lumora Watch Party', message: `${value}${appLink}` });
      setShareStatus('Invite ready to share.');
    } catch { setShareStatus('Sharing is unavailable on this device.'); }
  }

  return <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modal}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close Watch Party" onPress={onClose} style={styles.backdrop} />
      <View accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(12, insets.bottom) }]}>
        <View style={styles.header}>
          <View style={styles.headingWrap}>
            <View style={styles.headingRow}>
              <Text style={styles.heading}>Watch Party</Text>
              <View style={[styles.status, connected && styles.statusConnected]}>
                <Text style={styles.statusText}>{connectionLabel(session)}</Text>
              </View>
            </View>
            <Text style={styles.muted}>{WATCH_PARTY_SERVICE_AVAILABLE
              ? 'Invite friends, chat, and share host control.' : 'Party creation and joining are unavailable.'}</Text>
          </View>
          <Button label="Close party panel" variant="ghost" size="sm" onPress={onClose} />
        </View>

        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {!WATCH_PARTY_SERVICE_AVAILABLE ? <Text accessibilityRole="alert" style={styles.warning}>{WATCH_PARTY_UNAVAILABLE_MESSAGE}</Text> : null}
          {state.error ? <View accessibilityRole="alert" style={styles.errorBox}>
            <Text style={styles.errorText}>{state.error.message}</Text>
            {state.error.code === 'RATE_LIMITED' ? <Text style={styles.muted}>Sending is paused briefly.</Text> : null}
            <View style={styles.row}>
              {state.error.recoverable && state.phase === 'error'
                ? <Button label="Retry connection" size="sm" variant="secondary" disabled={!WATCH_PARTY_SERVICE_AVAILABLE}
                  onPress={() => { if (WATCH_PARTY_SERVICE_AVAILABLE) session.retry(); }} /> : null}
              <Button label="Dismiss error" size="sm" variant="ghost" onPress={session.clearError} />
            </View>
          </View> : null}

          {!hasRoom ? <View style={styles.section}>
            <Text style={styles.sectionTitle}>Start or join</Text>
            <Text style={styles.muted}>Names and chat are plain text. Never share passwords or private links.</Text>
            <Text style={styles.label}>Display name</Text>
            <TextInput accessibilityLabel="Watch Party display name" value={displayName}
              onChangeText={setDisplayName} maxLength={WATCH_PARTY_LIMITS.maxDisplayNameCharacters}
              autoCapitalize="words" autoCorrect={false} placeholder="Your name" placeholderTextColor={colors.contentSubtle}
              style={styles.input} editable={WATCH_PARTY_SERVICE_AVAILABLE} />
            <Button label="Create party for this title" onPress={createRoom}
              disabled={!WATCH_PARTY_SERVICE_AVAILABLE || state.phase === 'ticketing' || state.phase === 'connecting' || session.syncStatus === 'unsupported-media'} />
            {session.syncStatus === 'unsupported-media'
              ? <Text style={styles.warning}>This catalog item cannot create a protocol v1 room.</Text> : null}
            <View style={styles.divider}><View style={styles.line} /><Text style={styles.muted}>OR JOIN</Text><View style={styles.line} /></View>
            <Text style={styles.label}>Room code</Text>
            <TextInput accessibilityLabel="Watch Party room code" value={roomCode}
              onChangeText={(value) => setRoomCode(value.toUpperCase())} maxLength={12}
              autoCapitalize="characters" autoCorrect={false} placeholder="ABCDE23456"
              placeholderTextColor={colors.contentSubtle} style={[styles.input, styles.codeInput]}
              editable={WATCH_PARTY_SERVICE_AVAILABLE} onSubmitEditing={joinRoom} returnKeyType="go" />
            <Button label="Join room" variant="secondary" onPress={joinRoom}
              disabled={!WATCH_PARTY_SERVICE_AVAILABLE || state.phase === 'ticketing' || state.phase === 'connecting'} />
            {session.savedResume ? <Button label={`Resume ${session.savedResume.roomCode}`}
              variant="ghost" disabled={!WATCH_PARTY_SERVICE_AVAILABLE}
              onPress={() => { if (WATCH_PARTY_SERVICE_AVAILABLE) session.resume(); }} /> : null}
            {formError ? <Text accessibilityRole="alert" style={styles.errorText}>{formError}</Text> : null}
          </View> : <>
            <View style={styles.roomBox}>
              <View style={styles.roomRow}>
                <View><Text style={styles.muted}>Room code</Text>
                  <Text selectable style={styles.roomCode}>{state.room!.roomCode}</Text></View>
                <Button label="Share invite" size="sm" variant="secondary" onPress={() => void shareInvite()} />
              </View>
              <Text style={styles.muted}>{syncCopy(session.syncStatus)}</Text>
              {state.self?.role === 'member' && session.syncStatus === 'ready'
                ? <Text style={styles.warning}>The host controls play, pause, seek, and speed.</Text> : null}
              {state.playback?.mode === 'frozen'
                ? <Text style={styles.warning}>Party frozen: {state.playback.freezeReason.replace(/-/g, ' ')}</Text> : null}
              {shareStatus ? <Text accessibilityLiveRegion="polite" style={styles.success}>{shareStatus}</Text> : null}
            </View>

            <View style={styles.section}>
              <View style={styles.roomRow}><Text style={styles.sectionTitle}>People</Text>
                <Text style={styles.muted}>{connectedCount} connected</Text></View>
              {state.participants.map((participant) => <View key={participant.participantId} style={styles.person}>
                <View style={styles.headingWrap}>
                  <Text numberOfLines={1} style={styles.personName}>{participant.displayName}
                    {participant.participantId === state.self!.participantId ? ' (you)' : ''}</Text>
                  <Text style={styles.muted}>{participant.role === 'host' ? 'Host'
                    : participant.connected ? 'Connected' : 'Offline'}</Text>
                </View>
                {state.self!.role === 'host' && participant.role !== 'host' && participant.connected
                  ? <Button label={`Make ${participant.displayName} host`} size="sm" variant="ghost"
                    onPress={() => session.transferHost(participant.participantId)} /> : null}
              </View>)}
            </View>

            <View style={styles.section}>
              <View style={styles.roomRow}><Text style={styles.sectionTitle}>Chat</Text><Text style={styles.muted}>Plain text</Text></View>
              <View accessibilityLiveRegion="polite" style={styles.chatList}>
                {state.chat.length ? state.chat.map((message) => <Text key={message.messageId} style={styles.chatText}>
                  <Text style={styles.chatName}>{message.displayName}: </Text>{message.text}
                </Text>) : <Text style={styles.muted}>No messages yet.</Text>}
              </View>
              <TextInput accessibilityLabel="Watch Party chat message" value={chatText} onChangeText={setChatText}
                maxLength={WATCH_PARTY_LIMITS.maxChatCharacters} multiline numberOfLines={2}
                editable={connected && !rateLimited} placeholder={rateLimited ? 'Please wait before sending' : 'Message the room'}
                placeholderTextColor={colors.contentSubtle} style={[styles.input, styles.chatInput]} />
              <View style={styles.roomRow}><Text style={styles.muted}>{Array.from(chatText).length}/{WATCH_PARTY_LIMITS.maxChatCharacters}</Text>
                <Button label="Send message" size="sm" onPress={sendChat}
                  disabled={!connected || rateLimited || !chatText.trim()} /></View>
            </View>
            <Button label="Leave Watch Party" variant="ghost" onPress={session.leave} />
          </>}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  modal: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.68)' },
  sheet: { maxHeight: '88%', backgroundColor: colors.surfaceRaised, borderTopLeftRadius: 20,
    borderTopRightRadius: 20, borderWidth: 1, borderColor: colors.borderStrong, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
    padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  headingWrap: { flex: 1, minWidth: 0 },
  headingRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  heading: { color: colors.content, fontSize: 20, fontWeight: '700' },
  status: { backgroundColor: colors.surfaceOverlay, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 },
  statusConnected: { backgroundColor: colors.success + '22' },
  statusText: { color: colors.contentMuted, fontSize: 11, fontWeight: '700' },
  content: { padding: 16, gap: 18 },
  section: { gap: 10 },
  sectionTitle: { color: colors.content, fontSize: 16, fontWeight: '700' },
  muted: { color: colors.contentMuted, fontSize: 12 },
  label: { color: colors.contentMuted, fontSize: 12, fontWeight: '600' },
  input: { minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong,
    backgroundColor: colors.surface, color: colors.content, paddingHorizontal: 12, paddingVertical: 10 },
  codeInput: { fontSize: 17, fontWeight: '700', letterSpacing: 2 },
  chatInput: { minHeight: 68, textAlignVertical: 'top' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  line: { height: 1, flex: 1, backgroundColor: colors.border },
  errorBox: { gap: 8, padding: 12, borderRadius: 10, borderWidth: 1,
    borderColor: colors.danger + '88', backgroundColor: colors.danger + '12' },
  errorText: { color: colors.danger, fontSize: 13 },
  warning: { color: colors.warning, fontSize: 12 },
  success: { color: colors.success, fontSize: 12 },
  roomBox: { gap: 8, padding: 12, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, backgroundColor: colors.surface },
  roomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  roomCode: { color: colors.content, fontSize: 20, fontWeight: '800', letterSpacing: 2 },
  person: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  personName: { color: colors.content, fontSize: 14, fontWeight: '600' },
  chatList: { maxHeight: 240, gap: 8, padding: 12, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chatText: { color: colors.contentMuted, fontSize: 14, lineHeight: 20 },
  chatName: { color: colors.content, fontWeight: '700' },
});
