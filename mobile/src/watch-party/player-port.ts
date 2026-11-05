import type {
  WatchPartyClientFreezeReason,
  WatchPartyFreezeReason,
  WatchPartyMediaIdentity,
  WatchPartyPlaybackMode,
  WatchPartyPlaybackState,
} from './protocol';

export type PartyPlayerBlockReason = 'source-change' | 'ad-break' | 'buffering' | 'background' | 'not-ready';

export interface PartyPlayerSnapshot {
  media: WatchPartyMediaIdentity;
  positionSeconds: number;
  durationSeconds?: number;
  playing: boolean;
  mode: WatchPartyPlaybackMode;
  freezeReason?: WatchPartyFreezeReason;
  playbackRate: number;
  basePlaybackRate: number;
  ready: boolean;
  blockReasons: PartyPlayerBlockReason[];
  pictureInPicture: boolean;
}

export type PartyPlayerIntent =
  | { kind: 'freeze'; freezeReason: WatchPartyClientFreezeReason; snapshot: PartyPlayerSnapshot }
  | { kind: 'play' | 'pause' | 'seek' | 'rate'; freezeReason?: never; snapshot: PartyPlayerSnapshot };

export interface PartyPlayerTarget {
  playback: WatchPartyPlaybackState;
  positionSeconds: number;
  mode: WatchPartyPlaybackMode;
  freezeReason?: WatchPartyFreezeReason;
  playbackRate: number;
  seek: boolean;
  reason: 'snapshot' | 'status' | 'media' | 'drift' | 'rate' | 'steady';
}

export interface PartyPlayerPort {
  read: () => PartyPlayerSnapshot | null;
  apply: (target: PartyPlayerTarget) => void | Promise<void>;
  subscribe: (listener: (intent: PartyPlayerIntent) => void) => () => void;
}

export type RegisterPartyPlayerPort = (port: PartyPlayerPort | null) => void;
