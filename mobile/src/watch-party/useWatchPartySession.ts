import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  normalizeWatchPartyChat,
  normalizeWatchPartyDisplayName,
  normalizeWatchPartyRoomCode,
  planWatchPartyDrift,
  sameWatchPartyMediaIdentity,
  type WatchPartyClientMessage,
  type WatchPartyCorrectionState,
  type WatchPartyMediaIdentity,
  type WatchPartyPlaybackCommand,
  type WatchPartyServerMessage,
} from './protocol';
import { decodeWatchPartyServerMessage } from './codec';
import { watchPartyProtocolError, watchPartyUnavailableError } from './errors';
import type { PartyPlayerIntent, PartyPlayerPort, RegisterPartyPlayerPort } from './player-port';
import { INITIAL_WATCH_PARTY_STATE, watchPartyStateReducer, type WatchPartySessionState } from './reducer';
import { buildWatchPartyInviteUrl, buildWatchPartySchemeUrl, clearWatchPartyResume, readWatchPartyResume, writeWatchPartyResume,
  type StoredWatchPartyResume } from './storage';
import { WatchPartyTransport, type WatchPartyTransportStatus } from './transport';

export type WatchPartySyncStatus = 'chat-only-embed' | 'chat-only-unavailable' | 'unsupported-media'
  | 'different-media' | 'awaiting-player-port' | 'player-port-error' | 'local-blocked' | 'ready';

export interface WatchPartySessionController {
  state: WatchPartySessionState;
  savedResume: StoredWatchPartyResume | null;
  inviteUrl: string | null;
  appInviteUrl: string | null;
  syncStatus: WatchPartySyncStatus;
  create: (displayName: string) => boolean;
  join: (displayName: string, roomCode: string) => boolean;
  resume: () => boolean;
  retry: () => void;
  sendChat: (text: string) => boolean;
  transferHost: (participantId: string) => boolean;
  notifySourceChange: () => void;
  leave: () => void;
  clearError: () => void;
  registerPlayerPort: RegisterPartyPlayerPort;
}

interface UseWatchPartySessionOptions {
  media: WatchPartyMediaIdentity | null;
  surface: 'native' | 'embed' | 'unavailable';
  type: 'movie' | 'tv';
  slug: string;
  season?: number;
  episode?: number;
}

function commandForIntent(intent: PartyPlayerIntent): WatchPartyPlaybackCommand {
  if (intent.kind === 'freeze') return { kind: 'freeze', reason: intent.freezeReason };
  if (intent.kind === 'seek') return { kind: 'seek', positionSeconds: intent.snapshot.positionSeconds };
  if (intent.kind === 'rate') return { kind: 'rate', playbackRate: intent.snapshot.basePlaybackRate };
  return { kind: intent.kind };
}

export function useWatchPartySession(options: UseWatchPartySessionOptions): WatchPartySessionController {
  const { media, surface, type, slug, season, episode } = options;
  const [state, dispatch] = useReducer(watchPartyStateReducer, INITIAL_WATCH_PARTY_STATE);
  const [savedResume, setSavedResume] = useState<StoredWatchPartyResume | null>(null);
  const [playerPortAvailable, setPlayerPortAvailable] = useState(false);
  const [playerPortError, setPlayerPortError] = useState(false);
  const [playerLocalBlocked, setPlayerLocalBlocked] = useState(false);
  const stateRef = useRef(state);
  const mediaRef = useRef(media);
  const surfaceRef = useRef(surface);
  const transportRef = useRef<WatchPartyTransport | null>(null);
  const playerPortRef = useRef<PartyPlayerPort | null>(null);
  const playerUnsubscribeRef = useRef<(() => void) | null>(null);
  const leaveRequestRef = useRef<string | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const correctionStateRef = useRef<WatchPartyCorrectionState>('stable');
  const syncRequestRef = useRef<number | null>(null);
  const requestCounterRef = useRef(0);
  stateRef.current = state;
  mediaRef.current = media;
  surfaceRef.current = surface;

  const requestId = useCallback((prefix: string): string => {
    requestCounterRef.current += 1;
    return `${prefix}-${Date.now().toString(36)}-${requestCounterRef.current.toString(36)}`;
  }, []);

  const clearStoredResume = useCallback(() => {
    setSavedResume(null);
    void clearWatchPartyResume();
  }, []);

  const sendSync = useCallback((sinceRevision?: number) => {
    const current = stateRef.current;
    if (current.phase !== 'connected' || !current.room) return false;
    return transportRef.current?.send({ v: 1, type: 'client.sync', requestId: requestId('sync'),
      sinceRevision: sinceRevision ?? current.room.revision } satisfies WatchPartyClientMessage) ?? false;
  }, [requestId]);

  const sendPing = useCallback(() => {
    if (stateRef.current.phase !== 'connected') return false;
    const sentAt = Date.now();
    return transportRef.current?.send({ v: 1, type: 'client.ping', requestId: requestId('ping'),
      clientSentAtMs: sentAt } satisfies WatchPartyClientMessage) ?? false;
  }, [requestId]);

  useEffect(() => {
    let mounted = true;
    void readWatchPartyResume().then((value) => { if (mounted) setSavedResume(value); });
    const handleStatus = (status: WatchPartyTransportStatus) => {
      if (status.phase === 'ticketing') dispatch({ type: 'transport', phase: 'ticketing' });
      else if (status.phase === 'reconnecting') dispatch({ type: 'transport', phase: 'reconnecting',
        attempt: status.attempt, retryInMs: status.retryInMs });
      else if (status.phase === 'connecting') dispatch({ type: 'transport', phase: 'connecting' });
    };
    const transport = new WatchPartyTransport({
      onStatus: handleStatus,
      onMessage: (raw, receivedAtMs) => {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch {
          dispatch({ type: 'error', error: watchPartyProtocolError(), fatal: true });
          transportRef.current?.disconnect();
          return;
        }
        const decoded = decodeWatchPartyServerMessage(parsed);
        if (!decoded.ok) {
          dispatch({ type: 'error', error: watchPartyProtocolError(), fatal: true });
          transportRef.current?.disconnect();
          return;
        }
        const message: WatchPartyServerMessage = decoded.value;
        if (message.type === 'room.snapshot') {
          transportRef.current?.setResumeToken(message.self.resumeToken);
          void writeWatchPartyResume(message, receivedAtMs).then((stored) => { if (mounted) setSavedResume(stored); });
        }
        if (message.type === 'server.ack' && message.requestId === leaveRequestRef.current) {
          leaveRequestRef.current = null;
          if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
          leaveTimerRef.current = null;
          transportRef.current?.disconnect();
          clearStoredResume();
          dispatch({ type: 'left' });
          return;
        }
        if (message.type === 'room.closed') {
          clearStoredResume();
          transportRef.current?.disconnect();
        }
        dispatch({ type: 'server', message, receivedAtMs });
      },
      onError: (error, fatal) => {
        if (error.code === 'INVALID_TICKET' || error.code === 'TICKET_EXPIRED'
          || error.code === 'ROOM_NOT_FOUND' || error.code === 'ROOM_EXPIRED'
          || error.code === 'ROOM_CLOSED' || error.code === 'PARTICIPANT_NOT_FOUND') clearStoredResume();
        dispatch({ type: 'error', error, fatal });
      },
    });
    transportRef.current = transport;
    return () => {
      mounted = false;
      transport.disconnect();
      transportRef.current = null;
      if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
      playerUnsubscribeRef.current?.();
      playerUnsubscribeRef.current = null;
    };
  }, [clearStoredResume]);

  useEffect(() => {
    if (state.syncFromRevision === null || state.phase !== 'connected') {
      syncRequestRef.current = null;
      return;
    }
    if (syncRequestRef.current === state.syncFromRevision) return;
    if (sendSync(state.syncFromRevision)) syncRequestRef.current = state.syncFromRevision;
  }, [sendSync, state.phase, state.syncFromRevision]);

  useEffect(() => {
    if (state.phase !== 'connected') return;
    sendPing();
    const interval = setInterval(sendPing, 10_000);
    return () => clearInterval(interval);
  }, [sendPing, state.phase]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && stateRef.current.phase === 'connected') {
        correctionStateRef.current = 'stable';
        sendSync();
        sendPing();
      }
    });
    return () => subscription.remove();
  }, [sendPing, sendSync]);

  useEffect(() => {
    if (state.rateLimitedUntilMs === null) return;
    const remaining = state.rateLimitedUntilMs - Date.now();
    if (remaining <= 0) { dispatch({ type: 'clear-rate-limit' }); return; }
    const timer = setTimeout(() => dispatch({ type: 'clear-rate-limit' }), remaining);
    return () => clearTimeout(timer);
  }, [state.rateLimitedUntilMs]);

  const sendPlaybackIntent = useCallback((intent: PartyPlayerIntent) => {
    const current = stateRef.current;
    const currentMedia = mediaRef.current;
    if (surfaceRef.current !== 'native' || current.phase !== 'connected' || current.self?.role !== 'host'
      || !current.playback || !currentMedia || !sameWatchPartyMediaIdentity(intent.snapshot.media, currentMedia)) return;
    transportRef.current?.send({ v: 1, type: 'playback.command', requestId: requestId('playback'),
      baseRevision: current.playback.revision, command: commandForIntent(intent) } satisfies WatchPartyClientMessage);
  }, [requestId]);

  const registerPlayerPort = useCallback<RegisterPartyPlayerPort>((port) => {
    playerUnsubscribeRef.current?.();
    playerUnsubscribeRef.current = null;
    playerPortRef.current = port;
    correctionStateRef.current = 'stable';
    setPlayerPortAvailable(Boolean(port));
    setPlayerPortError(false);
    setPlayerLocalBlocked(Boolean(port?.read()?.blockReasons.length));
    if (port) playerUnsubscribeRef.current = port.subscribe((intent) => {
      setPlayerLocalBlocked(intent.snapshot.blockReasons.length > 0);
      sendPlaybackIntent(intent);
    });
  }, [sendPlaybackIntent]);

  useEffect(() => {
    if (surface !== 'native' || state.phase !== 'connected' || state.self?.role !== 'member'
      || !state.playback || !media || !sameWatchPartyMediaIdentity(state.playback.media, media)
      || !playerPortAvailable) return;
    let applying = false;
    let cancelled = false;
    const reconcile = () => {
      const port = playerPortRef.current;
      const playback = stateRef.current.playback;
      const snapshot = port?.read();
      if (!port || !playback || !snapshot || applying || cancelled) return;
      const blocked = !snapshot.ready || snapshot.blockReasons.length > 0;
      setPlayerLocalBlocked(blocked);
      if (blocked) { correctionStateRef.current = 'stable'; return; }
      const plan = planWatchPartyDrift({ playback, localMedia: snapshot.media,
        localPositionSeconds: snapshot.positionSeconds, localMode: snapshot.mode,
        localNowMs: Date.now(), clockSamples: stateRef.current.clockSamples,
        correctionState: correctionStateRef.current });
      correctionStateRef.current = plan.correctionState;
      const target = plan.kind === 'hard-sync'
        ? { playback, positionSeconds: plan.projectedPositionSeconds, mode: plan.mode,
          ...(plan.freezeReason ? { freezeReason: plan.freezeReason } : {}), playbackRate: plan.playbackRate,
          seek: true, reason: plan.reason === 'status' ? 'status' as const
            : plan.reason === 'media' ? 'media' as const : 'drift' as const }
        : plan.kind === 'rate'
          ? { playback, positionSeconds: plan.projectedPositionSeconds, mode: playback.mode,
            ...(playback.freezeReason ? { freezeReason: playback.freezeReason } : {}),
            playbackRate: plan.playbackRate, seek: false, reason: 'rate' as const }
          : { playback, positionSeconds: plan.projectedPositionSeconds, mode: playback.mode,
            ...(playback.freezeReason ? { freezeReason: playback.freezeReason } : {}),
            playbackRate: playback.playbackRate, seek: false, reason: 'steady' as const };
      applying = true;
      void Promise.resolve(port.apply(target)).catch(() => setPlayerPortError(true)).finally(() => { applying = false; });
    };
    reconcile();
    const interval = setInterval(reconcile, 1_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      if (correctionStateRef.current === 'correcting') {
        const port = playerPortRef.current;
        const playback = stateRef.current.playback;
        const snapshot = port?.read();
        if (port && playback && snapshot && snapshot.ready && !snapshot.blockReasons.length) {
          void Promise.resolve(port.apply({ playback, positionSeconds: snapshot.positionSeconds,
            mode: snapshot.mode, ...(snapshot.freezeReason ? { freezeReason: snapshot.freezeReason } : {}),
            playbackRate: playback.playbackRate, seek: false, reason: 'steady' })).catch(() => {});
        }
        correctionStateRef.current = 'stable';
      }
    };
  }, [playerPortAvailable, state.phase, state.playback, state.self?.role, surface,
    media?.kind, media?.mediaId, media?.kind === 'episode' ? media.episodeId : undefined,
    media?.kind === 'episode' ? media.seasonNumber : undefined,
    media?.kind === 'episode' ? media.episodeNumber : undefined]);

  const create = useCallback((displayName: string): boolean => {
    const normalized = normalizeWatchPartyDisplayName(displayName);
    const currentMedia = mediaRef.current;
    if (!normalized || !currentMedia) {
      dispatch({ type: 'error', error: watchPartyUnavailableError(), fatal: false });
      return false;
    }
    const player = playerPortRef.current?.read();
    const positionSeconds = player && sameWatchPartyMediaIdentity(player.media, currentMedia)
      ? player.positionSeconds : undefined;
    dispatch({ type: 'start' });
    transportRef.current?.start({ v: 1, action: 'create', platform: 'android', displayName: normalized,
      media: currentMedia, ...(positionSeconds === undefined ? {} : { positionSeconds }) });
    return true;
  }, []);

  const join = useCallback((displayName: string, roomCode: string): boolean => {
    const normalizedName = normalizeWatchPartyDisplayName(displayName);
    const normalizedCode = normalizeWatchPartyRoomCode(roomCode);
    if (!normalizedName || !normalizedCode) return false;
    dispatch({ type: 'start' });
    transportRef.current?.start({ v: 1, action: 'join', platform: 'android',
      displayName: normalizedName, roomCode: normalizedCode });
    return true;
  }, []);

  const resume = useCallback((): boolean => {
    if (!savedResume || savedResume.expiresAtMs <= Date.now()) { clearStoredResume(); return false; }
    dispatch({ type: 'start' });
    transportRef.current?.start({ v: 1, action: 'resume', platform: 'android', resumeToken: savedResume.resumeToken });
    return true;
  }, [clearStoredResume, savedResume]);

  const retry = useCallback(() => transportRef.current?.retry(), []);

  const sendChat = useCallback((text: string): boolean => {
    const normalized = normalizeWatchPartyChat(text);
    const current = stateRef.current;
    if (!normalized || current.phase !== 'connected'
      || (current.rateLimitedUntilMs !== null && current.rateLimitedUntilMs > Date.now())) return false;
    return transportRef.current?.send({ v: 1, type: 'chat.send', requestId: requestId('chat'),
      text: normalized } satisfies WatchPartyClientMessage) ?? false;
  }, [requestId]);

  const transferHost = useCallback((participantId: string): boolean => {
    const current = stateRef.current;
    if (current.phase !== 'connected' || current.self?.role !== 'host' || !current.room) return false;
    return transportRef.current?.send({ v: 1, type: 'host.transfer', requestId: requestId('transfer'),
      baseRevision: current.room.revision, participantId } satisfies WatchPartyClientMessage) ?? false;
  }, [requestId]);

  const notifySourceChange = useCallback(() => {
    const current = stateRef.current;
    const currentMedia = mediaRef.current;
    if (current.phase !== 'connected' || current.self?.role !== 'host' || !current.playback || !currentMedia
      || !sameWatchPartyMediaIdentity(current.playback.media, currentMedia)) return;
    transportRef.current?.send({ v: 1, type: 'playback.command', requestId: requestId('source'),
      baseRevision: current.playback.revision,
      command: { kind: 'freeze', reason: 'source-change' } } satisfies WatchPartyClientMessage);
  }, [requestId]);

  const leave = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== 'connected') {
      transportRef.current?.disconnect();
      clearStoredResume();
      dispatch({ type: 'left' });
      return;
    }
    const id = requestId('leave');
    leaveRequestRef.current = id;
    const sent = transportRef.current?.send({ v: 1, type: 'room.leave', requestId: id } satisfies WatchPartyClientMessage);
    if (!sent) {
      transportRef.current?.disconnect(); clearStoredResume(); dispatch({ type: 'left' }); return;
    }
    leaveTimerRef.current = setTimeout(() => {
      leaveRequestRef.current = null;
      transportRef.current?.disconnect();
      clearStoredResume();
      dispatch({ type: 'left' });
    }, 2_000);
  }, [clearStoredResume, requestId]);

  const syncStatus: WatchPartySyncStatus = surface === 'embed' ? 'chat-only-embed'
    : surface === 'unavailable' ? 'chat-only-unavailable'
      : !media ? 'unsupported-media'
        : state.playback && !sameWatchPartyMediaIdentity(state.playback.media, media) ? 'different-media'
          : !playerPortAvailable ? 'awaiting-player-port'
            : playerPortError ? 'player-port-error' : playerLocalBlocked ? 'local-blocked' : 'ready';
  const inviteUrl = state.room ? buildWatchPartyInviteUrl({ roomCode: state.room.roomCode,
    type, slug, ...(season === undefined ? {} : { season }), ...(episode === undefined ? {} : { episode }) }) : null;
  const appInviteUrl = state.room ? buildWatchPartySchemeUrl({ roomCode: state.room.roomCode,
    type, slug, ...(season === undefined ? {} : { season }), ...(episode === undefined ? {} : { episode }) }) : null;

  return { state, savedResume, inviteUrl, appInviteUrl, syncStatus, create, join, resume, retry, sendChat,
    transferHost, notifySourceChange, leave, clearError: () => dispatch({ type: 'clear-error' }), registerPlayerPort };
}
