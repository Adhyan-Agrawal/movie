/**
 * Player state machine + event vocabulary (Spec Section 9).
 *
 * The player surface is a small explicit state machine. Embed providers don't
 * expose fine-grained lifecycle events, so several of these states (seeking,
 * buffering, ended) are reserved for future native MP4/HLS playback; the iframe
 * player uses idle/loading/ready/consent-required/blocked and the error states.
 */

import type { PlaybackErrorCode } from '@/lib/providers/types';

export type PlayerState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'buffering'
  | 'ended'
  | 'blocked'
  | 'consent-required'
  | 'unsupported'
  | 'provider-error'
  | 'network-error';

export const PLAYER_STATES: readonly PlayerState[] = [
  'idle',
  'loading',
  'ready',
  'playing',
  'paused',
  'seeking',
  'buffering',
  'ended',
  'blocked',
  'consent-required',
  'unsupported',
  'provider-error',
  'network-error',
];

/**
 * Analytics/player events (Spec Section 9). Emitters must redact tokens and
 * full private URLs before recording any of these.
 */
export type PlayerEvent =
  | 'attempt'
  | 'success'
  | 'play'
  | 'pause'
  | 'seek'
  | 'quality'
  | 'caption'
  | 'audio'
  | 'heartbeat'
  | 'completion'
  | 'exit'
  | 'error';

export const PLAYER_EVENTS: readonly PlayerEvent[] = [
  'attempt',
  'success',
  'play',
  'pause',
  'seek',
  'quality',
  'caption',
  'audio',
  'heartbeat',
  'completion',
  'exit',
  'error',
];

/** States from which the viewer cannot proceed without recovery. */
export const ERROR_STATES: readonly PlayerState[] = [
  'blocked',
  'unsupported',
  'provider-error',
  'network-error',
];

export function isErrorState(state: PlayerState): boolean {
  return ERROR_STATES.includes(state);
}

export function isTerminalState(state: PlayerState): boolean {
  return state === 'ended' || isErrorState(state);
}

/** Map a normalized provider error code to the player state to display. */
export function playerStateForError(code: PlaybackErrorCode): PlayerState {
  switch (code) {
    case 'consent-required':
      return 'consent-required';
    case 'invalid-request':
    case 'unsupported':
      return 'unsupported';
    case 'timeout':
    case 'network':
      return 'network-error';
    case 'provider-error':
    case 'unknown':
      return 'provider-error';
    case 'provider-disabled':
    case 'host-not-allowed':
    case 'region-blocked':
    case 'not-found':
      return 'blocked';
    default:
      return 'provider-error';
  }
}
