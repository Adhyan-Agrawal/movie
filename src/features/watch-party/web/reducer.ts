import {
  WATCH_PARTY_DRIFT_POLICY,
  WATCH_PARTY_LIMITS,
  clockSample,
  type WatchPartyChatMessage,
  type WatchPartyClockSample,
  type WatchPartyParticipant,
  type WatchPartyPlaybackState,
  type WatchPartyReplayEvent,
  type WatchPartyRoomSnapshotMessage,
  type WatchPartyServerMessage,
} from '../protocol';
import {
  watchPartyError,
  type WatchPartyUiError,
} from './errors';

export type WatchPartyPhase = 'idle' | 'ticketing' | 'connecting' | 'reconnecting' | 'connected' | 'closed' | 'error';

export interface WatchPartyRoomView {
  roomCode: string;
  revision: number;
  createdAtMs: number;
  expiresAtMs: number;
  hostParticipantId: string;
}

export interface WatchPartySelfView {
  participantId: string;
  role: 'host' | 'member';
}

export interface WatchPartySessionState {
  phase: WatchPartyPhase;
  room: WatchPartyRoomView | null;
  self: WatchPartySelfView | null;
  playback: WatchPartyPlaybackState | null;
  participants: WatchPartyParticipant[];
  chat: WatchPartyChatMessage[];
  clockSamples: WatchPartyClockSample[];
  error: WatchPartyUiError | null;
  reconnectAttempt: number;
  reconnectInMs: number | null;
  syncFromRevision: number | null;
  rateLimitedUntilMs: number | null;
}

export const INITIAL_WATCH_PARTY_STATE: WatchPartySessionState = {
  phase: 'idle',
  room: null,
  self: null,
  playback: null,
  participants: [],
  chat: [],
  clockSamples: [],
  error: null,
  reconnectAttempt: 0,
  reconnectInMs: null,
  syncFromRevision: null,
  rateLimitedUntilMs: null,
};

function applyEvent(state: WatchPartySessionState, event: WatchPartyReplayEvent): WatchPartySessionState {
  if (!state.room) return state;
  const room = { ...state.room, revision: event.revision };
  if (event.type === 'playback.state') return { ...state, room, playback: event.playback };
  if (event.type === 'presence.state') {
    const self = state.self ? {
      ...state.self,
      role: state.self.participantId === event.hostParticipantId ? 'host' as const : 'member' as const,
    } : null;
    return { ...state, room: { ...room, hostParticipantId: event.hostParticipantId },
      self, participants: event.participants };
  }
  if (event.type === 'host.changed') {
    const participants = state.participants.map((participant) => ({
      ...participant,
      role: participant.participantId === event.hostParticipantId ? 'host' as const : 'member' as const,
    }));
    const self = state.self ? { ...state.self,
      role: state.self.participantId === event.hostParticipantId ? 'host' as const : 'member' as const } : null;
    return { ...state, room: { ...room, hostParticipantId: event.hostParticipantId }, self, participants };
  }
  if (state.chat.some((message) => message.messageId === event.message.messageId)) return { ...state, room };
  return { ...state, room,
    chat: [...state.chat, event.message].slice(-WATCH_PARTY_LIMITS.chatHistory) };
}

function snapshotState(state: WatchPartySessionState, snapshot: WatchPartyRoomSnapshotMessage): WatchPartySessionState {
  return {
    ...state,
    phase: 'connected',
    room: { ...snapshot.room },
    self: { participantId: snapshot.self.participantId, role: snapshot.self.role },
    playback: snapshot.playback,
    participants: snapshot.participants,
    chat: snapshot.chat.slice(-WATCH_PARTY_LIMITS.chatHistory),
    error: null,
    reconnectAttempt: 0,
    reconnectInMs: null,
    syncFromRevision: null,
    rateLimitedUntilMs: null,
  };
}

export function reduceWatchPartyServerMessage(state: WatchPartySessionState,
  message: WatchPartyServerMessage, receivedAtMs: number): WatchPartySessionState {
  if (message.type === 'room.snapshot') return snapshotState(state, message);
  if (message.type === 'room.closed') return {
    ...state,
    phase: 'closed',
    room: null,
    self: null,
    playback: null,
    participants: [],
    chat: [],
    error: watchPartyError(message.code),
    reconnectInMs: null,
    syncFromRevision: null,
  };
  if (message.type === 'server.pong') {
    const sample = clockSample(message.clientSentAtMs, receivedAtMs, message.serverTimeMs);
    return sample ? { ...state,
      clockSamples: [...state.clockSamples, sample].slice(-WATCH_PARTY_DRIFT_POLICY.clockSamples) } : state;
  }
  if (message.type === 'server.error') {
    const error = watchPartyError(message.code, message.retryAfterMs);
    return {
      ...state,
      error,
      ...(message.code === 'STALE_REVISION' && state.room ? { syncFromRevision: state.room.revision } : {}),
      ...(message.code === 'RATE_LIMITED' && message.retryAfterMs !== undefined
        ? { rateLimitedUntilMs: receivedAtMs + message.retryAfterMs } : {}),
    };
  }
  if (message.type === 'server.ack') return state.error?.code === 'STALE_REVISION'
    ? { ...state, error: null } : state;
  if (!state.room) return state;
  if (message.type === 'room.replay') {
    if (message.fromRevision > state.room.revision) return { ...state, syncFromRevision: state.room.revision };
    let next = state;
    for (const event of message.events) {
      if (!next.room || event.revision <= next.room.revision) continue;
      if (event.revision !== next.room.revision + 1) return { ...next, syncFromRevision: next.room.revision };
      next = applyEvent(next, event);
    }
    if (!next.room || next.room.revision !== message.revision) {
      return { ...next, syncFromRevision: next.room?.revision ?? 0 };
    }
    return { ...next, syncFromRevision: null, error: null };
  }
  if (message.revision <= state.room.revision) return state;
  if (message.revision !== state.room.revision + 1) return { ...state, syncFromRevision: state.room.revision };
  return { ...applyEvent(state, message), syncFromRevision: null };
}

export type WatchPartyStateAction =
  | { type: 'reset' }
  | { type: 'start' }
  | { type: 'transport'; phase: 'ticketing' | 'connecting' | 'reconnecting'; attempt?: number; retryInMs?: number }
  | { type: 'server'; message: WatchPartyServerMessage; receivedAtMs: number }
  | { type: 'error'; error: WatchPartyUiError; fatal?: boolean }
  | { type: 'clear-error' }
  | { type: 'clear-rate-limit' }
  | { type: 'left' };

export function watchPartyStateReducer(state: WatchPartySessionState,
  action: WatchPartyStateAction): WatchPartySessionState {
  switch (action.type) {
    case 'reset':
      return INITIAL_WATCH_PARTY_STATE;
    case 'start':
      return { ...INITIAL_WATCH_PARTY_STATE, phase: 'ticketing' };
    case 'transport':
      return { ...state, phase: action.phase, reconnectAttempt: action.attempt ?? 0,
        reconnectInMs: action.retryInMs ?? null, error: null };
    case 'server':
      return reduceWatchPartyServerMessage(state, action.message, action.receivedAtMs);
    case 'error':
      return { ...state, phase: action.fatal ? 'error' : state.phase, error: action.error,
        reconnectInMs: action.fatal ? null : state.reconnectInMs };
    case 'clear-error':
      return { ...state, error: null };
    case 'clear-rate-limit':
      return { ...state, rateLimitedUntilMs: null,
        error: state.error?.code === 'RATE_LIMITED' ? null : state.error };
    case 'left':
      return { ...INITIAL_WATCH_PARTY_STATE, phase: 'closed' };
  }
}
