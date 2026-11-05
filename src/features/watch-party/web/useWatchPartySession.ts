'use client';

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  WATCH_PARTY_PROTOCOL_VERSION,
  normalizeWatchPartyChat,
  normalizeWatchPartyDisplayName,
  normalizeWatchPartyRoomCode,
  parseWatchPartyMediaIdentity,
  planWatchPartyDrift,
  sameWatchPartyMediaIdentity,
  type WatchPartyClientMessage,
  type WatchPartyCorrectionState,
  type WatchPartyMediaIdentity,
  type WatchPartyPlaybackCommand,
  type WatchPartyServerMessage,
} from '../protocol';
import { decodeWatchPartyServerMessage } from './codec';
import {
  watchPartyProtocolError,
  watchPartyUnavailableError,
} from './errors';
import type {
  PartyPlayerIntent,
  PartyPlayerPort,
  RegisterPartyPlayerPort,
} from './player-port';
import {
  INITIAL_WATCH_PARTY_STATE,
  watchPartyStateReducer,
  type WatchPartySessionState,
} from './reducer';
import {
  buildWatchPartyInviteUrl,
  clearWatchPartyResume,
  readWatchPartyResume,
  writeWatchPartyResume,
  type StoredWatchPartyResume,
} from './session-storage';
import {
  WatchPartyTransport,
  type WatchPartyTransportStatus,
} from './transport';

export type WatchPartySyncStatus =
  | 'unavailable'
  | 'chat-only-embed'
  | 'chat-only-unavailable'
  | 'unsupported-media'
  | 'different-media'
  | 'awaiting-player-port'
  | 'player-port-error'
  | 'ready';

export interface WatchPartySessionController {
  available: boolean;
  state: WatchPartySessionState;
  savedResume: StoredWatchPartyResume | null;
  inviteUrl: string | null;
  syncStatus: WatchPartySyncStatus;
  create: (displayName: string) => boolean;
  join: (displayName: string, roomCode: string) => boolean;
  resume: () => boolean;
  retry: () => void;
  sendChat: (text: string) => boolean;
  transferHost: (participantId: string) => boolean;
  leave: () => void;
  clearError: () => void;
  registerPlayerPort: RegisterPartyPlayerPort;
}

interface UseWatchPartySessionOptions {
  configured?: boolean;
  media: WatchPartyMediaIdentity | null;
  surface: 'native' | 'embed' | 'unavailable';
}

function commandForIntent(intent: PartyPlayerIntent): WatchPartyPlaybackCommand {
  if (intent.kind === 'freeze') return { kind: 'freeze', reason: intent.freezeReason };
  if (intent.kind === 'seek') return { kind: 'seek', positionSeconds: intent.snapshot.positionSeconds };
  if (intent.kind === 'rate') return { kind: 'rate', playbackRate: intent.snapshot.playbackRate };
  return { kind: intent.kind };
}

export function useWatchPartySession({ configured = false, media, surface }: UseWatchPartySessionOptions): WatchPartySessionController {
  const available = configured === true;
  const [state, dispatch] = useReducer(watchPartyStateReducer, INITIAL_WATCH_PARTY_STATE);
  const [savedResume, setSavedResume] = useState<StoredWatchPartyResume | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [playerPortAvailable, setPlayerPortAvailable] = useState(false);
  const [playerPortError, setPlayerPortError] = useState(false);
  const stateRef = useRef(state);
  const availableRef = useRef(available);
  const mediaRef = useRef(media);
  const surfaceRef = useRef(surface);
  const transportRef = useRef<WatchPartyTransport | null>(null);
  const playerPortRef = useRef<PartyPlayerPort | null>(null);
  const playerUnsubscribeRef = useRef<(() => void) | null>(null);
  const leaveRequestRef = useRef<string | null>(null);
  const leaveTimerRef = useRef<number | null>(null);
  const correctionStateRef = useRef<WatchPartyCorrectionState>('stable');
  const syncRequestRef = useRef<number | null>(null);
  const requestCounterRef = useRef(0);
  stateRef.current = state;
  availableRef.current = available;
  mediaRef.current = media;
  surfaceRef.current = surface;

  const requestId = useCallback((prefix: string): string => {
    requestCounterRef.current += 1;
    return `${prefix}-${Date.now().toString(36)}-${requestCounterRef.current.toString(36)}`;
  }, []);

  const clearStoredResume = useCallback(() => {
    clearWatchPartyResume();
    setSavedResume(null);
  }, []);

  useEffect(() => {
    let active = true;
    const handleStatus = (status: WatchPartyTransportStatus) => {
      if (!active || !availableRef.current) return;
      if (status.phase === 'ticketing') dispatch({ type: 'transport', phase: 'ticketing' });
      else if (status.phase === 'reconnecting') dispatch({ type: 'transport', phase: 'reconnecting',
        attempt: status.attempt, retryInMs: status.retryInMs });
      else dispatch({ type: 'transport', phase: 'connecting' });
    };
    const transport = new WatchPartyTransport({
      onStatus: handleStatus,
      onMessage: (raw, receivedAtMs) => {
        if (!active || !availableRef.current) return;
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
          setSavedResume(writeWatchPartyResume(undefined, message, receivedAtMs));
        }
        if (message.type === 'server.ack' && message.requestId === leaveRequestRef.current) {
          leaveRequestRef.current = null;
          if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
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
        if (!active || !availableRef.current) return;
        if (error.code === 'INVALID_TICKET' || error.code === 'TICKET_EXPIRED'
          || error.code === 'ROOM_NOT_FOUND' || error.code === 'ROOM_EXPIRED'
          || error.code === 'ROOM_CLOSED' || error.code === 'PARTICIPANT_NOT_FOUND') {
          clearStoredResume();
        }
        dispatch({ type: 'error', error, fatal });
      },
    });
    transportRef.current = transport;
    return () => {
      active = false;
      transport.disconnect();
      transportRef.current = null;
      if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
      playerUnsubscribeRef.current?.();
      playerUnsubscribeRef.current = null;
    };
  }, [clearStoredResume]);

  useEffect(() => {
    setSavedResume(available ? readWatchPartyResume() : null);
    if (!available) {
      transportRef.current?.disconnect();
      dispatch({ type: 'reset' });
    }
  }, [available]);

  const activeRoomCode = state.room?.roomCode ?? null;
  useEffect(() => {
    if (!activeRoomCode || typeof window === 'undefined') {
      setInviteUrl(null);
      return;
    }
    setInviteUrl(buildWatchPartyInviteUrl(window.location.href, activeRoomCode));
  }, [activeRoomCode]);

  useEffect(() => {
    if (!available || state.syncFromRevision === null || state.phase !== 'connected') {
      syncRequestRef.current = null;
      return;
    }
    if (syncRequestRef.current === state.syncFromRevision) return;
    const id = requestId('sync');
    const sent = transportRef.current?.send({
      v: WATCH_PARTY_PROTOCOL_VERSION,
      type: 'client.sync',
      requestId: id,
      sinceRevision: state.syncFromRevision,
    } satisfies WatchPartyClientMessage);
    if (sent) syncRequestRef.current = state.syncFromRevision;
  }, [available, state.phase, state.syncFromRevision, requestId]);

  useEffect(() => {
    if (!available || state.phase !== 'connected') return;
    const ping = () => {
      const sentAt = Date.now();
      transportRef.current?.send({
        v: WATCH_PARTY_PROTOCOL_VERSION,
        type: 'client.ping',
        requestId: requestId('ping'),
        clientSentAtMs: sentAt,
      } satisfies WatchPartyClientMessage);
    };
    ping();
    const interval = window.setInterval(ping, 10_000);
    return () => window.clearInterval(interval);
  }, [available, state.phase, requestId]);

  useEffect(() => {
    if (state.rateLimitedUntilMs === null) return;
    const remaining = state.rateLimitedUntilMs - Date.now();
    if (remaining <= 0) {
      dispatch({ type: 'clear-rate-limit' });
      return;
    }
    const timer = window.setTimeout(() => dispatch({ type: 'clear-rate-limit' }), remaining);
    return () => window.clearTimeout(timer);
  }, [state.rateLimitedUntilMs]);

  const sendPlaybackIntent = useCallback((intent: PartyPlayerIntent) => {
    const current = stateRef.current;
    const currentMedia = mediaRef.current;
    if (!availableRef.current || surfaceRef.current !== 'native' || current.phase !== 'connected' || current.self?.role !== 'host'
      || !current.playback || !currentMedia
      || !sameWatchPartyMediaIdentity(intent.snapshot.media, currentMedia)) return;
    transportRef.current?.send({
      v: 1,
      type: 'playback.command',
      requestId: requestId('playback'),
      baseRevision: current.playback.revision,
      command: commandForIntent(intent),
    } satisfies WatchPartyClientMessage);
  }, [requestId]);

  const registerPlayerPort = useCallback<RegisterPartyPlayerPort>((port) => {
    playerUnsubscribeRef.current?.();
    playerUnsubscribeRef.current = null;
    playerPortRef.current = port;
    correctionStateRef.current = 'stable';
    setPlayerPortAvailable(Boolean(port));
    setPlayerPortError(false);
    if (port) playerUnsubscribeRef.current = port.subscribe(sendPlaybackIntent);
  }, [sendPlaybackIntent]);

  useEffect(() => {
    if (!available || surface !== 'native' || state.phase !== 'connected' || state.self?.role !== 'member'
      || !state.playback || !media || !sameWatchPartyMediaIdentity(state.playback.media, media)
      || !playerPortAvailable) return;
    let applying = false;
    const reconcile = () => {
      const port = playerPortRef.current;
      const playback = stateRef.current.playback;
      const snapshot = port?.read();
      if (!port || !playback || !snapshot || applying) return;
      const plan = planWatchPartyDrift({
        playback,
        localMedia: snapshot.media,
        localPositionSeconds: snapshot.positionSeconds,
        localMode: snapshot.mode,
        localNowMs: Date.now(),
        clockSamples: stateRef.current.clockSamples,
        correctionState: correctionStateRef.current,
      });
      correctionStateRef.current = plan.correctionState;
      const target = plan.kind === 'hard-sync'
        ? { playback, positionSeconds: plan.projectedPositionSeconds, mode: plan.mode,
          ...(plan.freezeReason ? { freezeReason: plan.freezeReason } : {}),
          playbackRate: plan.playbackRate, seek: true,
          reason: plan.reason === 'status' ? 'status' as const : plan.reason === 'media' ? 'media' as const : 'drift' as const }
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
    const interval = window.setInterval(reconcile, 1_000);
    return () => window.clearInterval(interval);
  }, [available, media, playerPortAvailable, state.phase, state.playback, state.self?.role, surface]);

  const create = useCallback((displayName: string): boolean => {
    if (!availableRef.current || !transportRef.current) return false;
    const normalized = normalizeWatchPartyDisplayName(displayName);
    const currentMedia = parseWatchPartyMediaIdentity(mediaRef.current);
    if (!normalized || !currentMedia) {
      dispatch({ type: 'error', error: watchPartyUnavailableError(), fatal: false });
      return false;
    }
    const player = playerPortRef.current?.read();
    const positionSeconds = player && sameWatchPartyMediaIdentity(player.media, currentMedia)
      ? player.positionSeconds : undefined;
    dispatch({ type: 'start' });
    transportRef.current?.start({
      v: 1,
      action: 'create',
      platform: 'web',
      displayName: normalized,
      media: currentMedia,
      ...(positionSeconds === undefined ? {} : { positionSeconds }),
    });
    return true;
  }, []);

  const join = useCallback((displayName: string, roomCode: string): boolean => {
    if (!availableRef.current || !transportRef.current) return false;
    const normalizedName = normalizeWatchPartyDisplayName(displayName);
    const normalizedCode = normalizeWatchPartyRoomCode(roomCode);
    if (!normalizedName || !normalizedCode) return false;
    dispatch({ type: 'start' });
    transportRef.current?.start({ v: 1, action: 'join', platform: 'web',
      displayName: normalizedName, roomCode: normalizedCode });
    return true;
  }, []);

  const resume = useCallback((): boolean => {
    if (!availableRef.current || !transportRef.current) return false;
    const stored = readWatchPartyResume();
    if (!stored) {
      setSavedResume(null);
      return false;
    }
    setSavedResume(stored);
    dispatch({ type: 'start' });
    transportRef.current?.start({ v: 1, action: 'resume', platform: 'web', resumeToken: stored.resumeToken });
    return true;
  }, []);

  const retry = useCallback(() => {
    if (availableRef.current) transportRef.current?.retry();
  }, []);

  const sendChat = useCallback((text: string): boolean => {
    const normalized = normalizeWatchPartyChat(text);
    const current = stateRef.current;
    if (!availableRef.current || !normalized || current.phase !== 'connected'
      || (current.rateLimitedUntilMs !== null && current.rateLimitedUntilMs > Date.now())) return false;
    return transportRef.current?.send({ v: 1, type: 'chat.send', requestId: requestId('chat'),
      text: normalized } satisfies WatchPartyClientMessage) ?? false;
  }, [requestId]);

  const transferHost = useCallback((participantId: string): boolean => {
    const current = stateRef.current;
    if (!availableRef.current || current.phase !== 'connected' || current.self?.role !== 'host' || !current.room) return false;
    return transportRef.current?.send({ v: 1, type: 'host.transfer', requestId: requestId('transfer'),
      baseRevision: current.room.revision, participantId } satisfies WatchPartyClientMessage) ?? false;
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
    const sent = transportRef.current?.send(({
      v: 1,
      type: 'room.leave',
      requestId: id,
    }) satisfies WatchPartyClientMessage);
    if (!sent) {
      transportRef.current?.disconnect();
      clearStoredResume();
      dispatch({ type: 'left' });
      return;
    }
    leaveTimerRef.current = window.setTimeout(() => {
      leaveRequestRef.current = null;
      transportRef.current?.disconnect();
      clearStoredResume();
      dispatch({ type: 'left' });
    }, 2_000);
  }, [clearStoredResume, requestId]);

  let syncStatus: WatchPartySyncStatus = 'ready';
  if (!available) syncStatus = 'unavailable';
  else if (!media || !parseWatchPartyMediaIdentity(media)) syncStatus = 'unsupported-media';
  else if (surface === 'embed') syncStatus = 'chat-only-embed';
  else if (surface === 'unavailable') syncStatus = 'chat-only-unavailable';
  else if (state.playback && !sameWatchPartyMediaIdentity(state.playback.media, media)) syncStatus = 'different-media';
  else if (!playerPortAvailable) syncStatus = 'awaiting-player-port';
  else if (playerPortError) syncStatus = 'player-port-error';

  return {
    available,
    state,
    savedResume,
    inviteUrl,
    syncStatus,
    create,
    join,
    resume,
    retry,
    sendChat,
    transferHost,
    leave,
    clearError: () => dispatch({ type: 'clear-error' }),
    registerPlayerPort,
  };
}
