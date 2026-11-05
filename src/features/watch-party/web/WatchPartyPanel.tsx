'use client';

import {
  useEffect,
  useState,
  type FormEvent,
} from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import {
  WATCH_PARTY_LIMITS,
  normalizeWatchPartyRoomCode,
} from '../protocol';
import type { WatchPartySessionController, WatchPartySyncStatus } from './useWatchPartySession';

export interface WatchPartyPanelProps {
  open: boolean;
  onClose: () => void;
  session: WatchPartySessionController;
  initialRoomCode?: string;
}

const inputClasses = 'h-11 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-content ' +
  'placeholder:text-content-subtle focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';

function syncCopy(status: WatchPartySyncStatus): string {
  if (status === 'unavailable') return 'Watch Party unavailable.';
  if (status === 'chat-only-embed') return 'Chat only. External players do not expose safe playback synchronization.';
  if (status === 'chat-only-unavailable') return 'Chat only. A native playback source is not available on this page.';
  if (status === 'unsupported-media') return 'Chat is available, but this title cannot use protocol v1 playback sync.';
  if (status === 'different-media') return 'Chat only. This room is watching a different title or episode.';
  if (status === 'awaiting-player-port') return 'Playback sync unavailable. This player does not expose a registered synchronization port.';
  if (status === 'player-port-error') return 'Chat is connected, but playback sync could not reach the native player.';
  return 'Native playback synchronization is available.';
}

function connectionLabel(session: WatchPartySessionController): string {
  if (!session.available) return 'Unavailable';
  const { phase, reconnectAttempt } = session.state;
  if (phase === 'ticketing') return 'Getting a secure ticket';
  if (phase === 'connecting') return 'Connecting';
  if (phase === 'reconnecting') return `Reconnecting (attempt ${reconnectAttempt})`;
  if (phase === 'connected') return 'Connected';
  if (phase === 'closed') return 'Room closed';
  if (phase === 'error') return 'Connection stopped';
  return 'Not connected';
}

export function WatchPartyPanel({ open, onClose, session, initialRoomCode }: WatchPartyPanelProps) {
  const [displayName, setDisplayName] = useState('');
  const [roomCode, setRoomCode] = useState(initialRoomCode ?? '');
  const [chatText, setChatText] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (initialRoomCode) setRoomCode(initialRoomCode);
  }, [initialRoomCode]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const { state } = session;
  const hasRoom = Boolean(state.room && state.self);
  const connected = session.available && state.phase === 'connected';
  const connectedCount = state.participants.filter((participant) => participant.connected).length;
  const rateLimited = state.rateLimitedUntilMs !== null && state.rateLimitedUntilMs > Date.now();

  function submitJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session.available) return;
    setFormError('');
    const normalized = normalizeWatchPartyRoomCode(roomCode);
    if (!normalized || !session.join(displayName, normalized)) {
      setFormError('Enter a name and a valid 10-character room code.');
      return;
    }
    setRoomCode(normalized);
  }

  function createRoom() {
    if (!session.available) return;
    setFormError('');
    if (!session.create(displayName)) setFormError('Enter a display name before creating a room.');
  }

  function submitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session.sendChat(chatText)) return;
    setChatText('');
  }

  async function copyInvite() {
    const value = session.inviteUrl ?? state.room?.roomCode;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus('Invite copied.');
    } catch {
      setCopyStatus('Copy was blocked. Select the room code instead.');
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close Watch Party"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm lg:hidden"
      />
      <aside
        role="dialog"
        aria-label="Watch Party"
        aria-modal="false"
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[86dvh] flex-col overflow-hidden rounded-t-2xl border border-border-strong bg-surface-raised shadow-raised',
          'lg:static lg:z-auto lg:max-h-[min(46rem,calc(100vh-7rem))] lg:min-h-[28rem] lg:rounded-xl',
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-semibold">Watch Party</h2>
              <Badge tone={connected ? 'success' : state.phase === 'error' ? 'danger' : 'neutral'}>
                {connectionLabel(session)}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-content-muted">{session.available
              ? 'Invite friends, chat, and share host control.' : 'Watch Party is not configured for this site.'}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close party panel">Close</Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {!session.available ? (
            <p role="status" className="rounded-md border border-border bg-surface p-3 text-sm text-content-muted">
              Watch Party unavailable
            </p>
          ) : <>
          {state.error ? (
            <div role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
              <p>{state.error.message}</p>
              {state.error.code === 'RATE_LIMITED' ? <p className="mt-1 text-xs">Sending is paused briefly.</p> : null}
              <div className="mt-2 flex gap-2">
                {state.error.recoverable && state.phase === 'error' ? (
                  <Button size="sm" variant="secondary" onClick={session.retry}>Retry connection</Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={session.clearError}>Dismiss</Button>
              </div>
            </div>
          ) : null}

          {!hasRoom ? (
            <div className="flex flex-col gap-5">
              <p className="text-xs text-content-muted">{syncCopy(session.syncStatus)}</p>
              <section aria-labelledby="party-start-heading" className="space-y-3">
                <div>
                  <h3 id="party-start-heading" className="text-sm font-semibold">Start or join</h3>
                  <p className="mt-1 text-xs text-content-muted">Names and chat are plain text. Never share passwords or private links.</p>
                </div>
                <label className="block text-xs font-medium text-content-muted">
                  Display name
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    maxLength={WATCH_PARTY_LIMITS.maxDisplayNameCharacters}
                    autoComplete="nickname"
                    className={cn(inputClasses, 'mt-1')}
                    placeholder="Your name"
                  />
                </label>
                <Button
                  variant="primary"
                  className="w-full"
                  disabled={state.phase === 'ticketing' || state.phase === 'connecting'
                    || session.syncStatus === 'unsupported-media'}
                  onClick={createRoom}
                >
                  Create party for this title
                </Button>
                {session.syncStatus === 'unsupported-media' ? (
                  <p className="text-xs text-warning">This catalog item does not have the stable media identity required to create a v1 room.</p>
                ) : null}
              </section>

              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-border" />
                <span className="text-[11px] uppercase tracking-widest text-content-subtle">or join</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <form onSubmit={submitJoin} className="space-y-3">
                <label className="block text-xs font-medium text-content-muted">
                  Room code
                  <input
                    value={roomCode}
                    onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                    maxLength={12}
                    autoCapitalize="characters"
                    autoComplete="off"
                    className={cn(inputClasses, 'mt-1 font-mono tracking-widest')}
                    placeholder="ABCDE23456"
                  />
                </label>
                <Button variant="secondary" className="w-full" type="submit"
                  disabled={state.phase === 'ticketing' || state.phase === 'connecting'}>
                  Join room
                </Button>
              </form>

              {session.savedResume ? (
                <Button variant="ghost" className="w-full" onClick={() => session.resume()}>
                  Resume {session.savedResume.roomCode}
                </Button>
              ) : null}
              {formError ? <p role="alert" className="text-xs text-danger">{formError}</p> : null}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <section aria-labelledby="party-room-heading" className="rounded-lg border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p id="party-room-heading" className="text-xs text-content-muted">Room code</p>
                    <p className="select-all font-mono text-lg font-semibold tracking-widest">{state.room!.roomCode}</p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => void copyInvite()}>Copy invite</Button>
                </div>
                <p className="mt-2 text-xs text-content-muted">{syncCopy(session.syncStatus)}</p>
                <p role="status" aria-live="polite" className="mt-1 min-h-4 text-xs text-success">{copyStatus}</p>
              </section>

              <section aria-labelledby="party-presence-heading">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 id="party-presence-heading" className="text-sm font-semibold">People</h3>
                  <span className="text-xs text-content-muted">{connectedCount} connected</span>
                </div>
                <ul className="space-y-2">
                  {state.participants.map((participant) => (
                    <li key={participant.participantId}
                      className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {participant.displayName}
                          {participant.participantId === state.self!.participantId ? ' (you)' : ''}
                        </p>
                        <p className="text-xs text-content-subtle">
                          {participant.role === 'host' ? 'Host' : participant.connected ? 'Connected' : 'Offline'}
                        </p>
                      </div>
                      {state.self!.role === 'host' && participant.role !== 'host' && participant.connected ? (
                        <Button size="sm" variant="ghost" onClick={() => session.transferHost(participant.participantId)}>
                          Make host
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>

              <section aria-labelledby="party-chat-heading">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 id="party-chat-heading" className="text-sm font-semibold">Chat</h3>
                  <span className="text-xs text-content-subtle">Plain text</span>
                </div>
                <ol aria-live="polite" aria-relevant="additions"
                  className="mb-3 max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border bg-surface p-3">
                  {state.chat.length ? state.chat.map((message) => (
                    <li key={message.messageId} className="text-sm">
                      <span className="font-semibold text-content">{message.displayName}: </span>
                      <span className="whitespace-pre-wrap break-words text-content-muted">{message.text}</span>
                    </li>
                  )) : <li className="text-sm text-content-subtle">No messages yet.</li>}
                </ol>
                <form onSubmit={submitChat} className="space-y-2">
                  <label className="sr-only" htmlFor="watch-party-chat-input">Message</label>
                  <textarea
                    id="watch-party-chat-input"
                    value={chatText}
                    onChange={(event) => setChatText(event.target.value)}
                    maxLength={WATCH_PARTY_LIMITS.maxChatCharacters}
                    rows={2}
                    disabled={!connected || rateLimited}
                    className={cn(inputClasses, 'h-auto min-h-16 resize-none py-2')}
                    placeholder={rateLimited ? 'Please wait before sending again' : 'Message the room'}
                  />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-content-subtle">
                      {chatText.length}/{WATCH_PARTY_LIMITS.maxChatCharacters}
                    </span>
                    <Button size="sm" type="submit" disabled={!connected || rateLimited || !chatText.trim()}>
                      Send
                    </Button>
                  </div>
                </form>
              </section>

              <Button variant="ghost" className="w-full text-danger" onClick={session.leave}>Leave party</Button>
            </div>
          )}
          </>}
        </div>
      </aside>
    </>
  );
}
