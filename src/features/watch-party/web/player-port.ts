import type {
  WatchPartyClientFreezeReason,
  WatchPartyFreezeReason,
  WatchPartyMediaIdentity,
  WatchPartyPlaybackMode,
  WatchPartyPlaybackState,
} from '../protocol';

export interface PartyPlayerSnapshot {
  media: WatchPartyMediaIdentity;
  positionSeconds: number;
  mode: WatchPartyPlaybackMode;
  freezeReason?: WatchPartyFreezeReason;
  playbackRate: number;
}

export type PartyPlayerIntent =
  | {
    kind: 'freeze';
    freezeReason: WatchPartyClientFreezeReason;
    snapshot: PartyPlayerSnapshot;
  }
  | {
    kind: 'play' | 'pause' | 'seek' | 'rate';
    freezeReason?: never;
    snapshot: PartyPlayerSnapshot;
  };

export interface PartyPlayerTarget {
  playback: WatchPartyPlaybackState;
  positionSeconds: number;
  mode: WatchPartyPlaybackMode;
  freezeReason?: WatchPartyFreezeReason;
  playbackRate: number;
  seek: boolean;
  reason: 'snapshot' | 'status' | 'media' | 'drift' | 'rate' | 'steady';
}

/**
 * Narrow bridge for NativePlayer. Applying a remote target must not emit a
 * matching local intent; otherwise remote state would echo back to the room.
 */
export interface PartyPlayerPort {
  read: () => PartyPlayerSnapshot | null;
  apply: (target: PartyPlayerTarget) => void | Promise<void>;
  subscribe: (listener: (intent: PartyPlayerIntent) => void) => () => void;
}

export type RegisterPartyPlayerPort = (port: PartyPlayerPort | null) => void;

export interface PartyPlayerPortRegistrationProps {
  registerPartyPlayerPort?: RegisterPartyPlayerPort;
}
