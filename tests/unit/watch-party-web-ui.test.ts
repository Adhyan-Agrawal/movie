import { createElement, type AnchorHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WatchPartyPanel } from '@/features/watch-party/web/WatchPartyPanel';
import { watchPartyError } from '@/features/watch-party/web/errors';
import type { WatchPartySessionController } from '@/features/watch-party/web/useWatchPartySession';
import { INITIAL_WATCH_PARTY_STATE } from '@/features/watch-party/web/reducer';
import { watchPartyConnectSource } from '../../next.config.mjs';

vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement('a', props),
}));

import { PlayerControlsBar } from '@/features/player/PlayerControlsBar';

const HOST_ID = '10000000-0000-4000-8000-000000000001';
const MEMBER_ID = '10000000-0000-4000-8000-000000000002';
const MESSAGE_ID = '10000000-0000-4000-8000-000000000003';

function controller(overrides: Partial<WatchPartySessionController> = {}): WatchPartySessionController {
  return {
    available: true,
    state: {
      ...INITIAL_WATCH_PARTY_STATE,
      phase: 'connected',
      room: { roomCode: 'ABCDE23456', revision: 3, createdAtMs: 1, expiresAtMs: 9_999,
        hostParticipantId: HOST_ID },
      self: { participantId: MEMBER_ID, role: 'member' },
      participants: [
        { participantId: HOST_ID, displayName: '<Host>', role: 'host', connected: true, joinedAtMs: 1 },
        { participantId: MEMBER_ID, displayName: 'Viewer', role: 'member', connected: true, joinedAtMs: 2 },
      ],
      chat: [{ messageId: MESSAGE_ID, participantId: HOST_ID, displayName: '<Host>',
        text: '<img src=x onerror=alert(1)>', format: 'plain', revision: 3, serverTimeMs: 3 }],
    },
    savedResume: null,
    inviteUrl: 'https://app.example/watch/movie/title?party=ABCDE23456',
    syncStatus: 'chat-only-embed',
    create: vi.fn(() => true),
    join: vi.fn(() => true),
    resume: vi.fn(() => true),
    retry: vi.fn(),
    sendChat: vi.fn(() => true),
    transferHost: vi.fn(() => true),
    leave: vi.fn(),
    clearError: vi.fn(),
    registerPlayerPort: vi.fn(),
    ...overrides,
  };
}

describe('Watch Party web UI safety', () => {
  it('renders names and bounded chat as escaped text and labels embeds chat-only', () => {
    const markup = renderToStaticMarkup(createElement(WatchPartyPanel, {
      open: true,
      onClose: vi.fn(),
      session: controller(),
    }));
    expect(markup).toContain('&lt;Host&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img src=x');
    expect(markup).not.toContain('<script');
    expect(markup).toContain('External players do not expose safe playback synchronization');
    expect(markup).toContain('2 connected');
  });

  it('shows fixed rate-limit and sanitized error UI without reflecting server text', () => {
    const session = controller({
      state: {
        ...controller().state,
        error: watchPartyError('RATE_LIMITED', 5_000),
        rateLimitedUntilMs: Date.now() + 5_000,
      },
    });
    const markup = renderToStaticMarkup(createElement(WatchPartyPanel, {
      open: true,
      onClose: vi.fn(),
      session,
    }));
    expect(markup).toContain('Too many Watch Party actions were sent');
    expect(markup).toContain('Sending is paused briefly');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('token=');
  });

  it('adds only the exact configured Watch Party socket origin to CSP', () => {
    expect(watchPartyConnectSource('https://party.example')).toBe('wss://party.example');
    expect(watchPartyConnectSource('https://party.example/base')).toBeNull();
    expect(watchPartyConnectSource('wss://party.example')).toBeNull();
    expect(watchPartyConnectSource('https://user:pass@party.example')).toBeNull();
  });

  it('exposes invite/join and connected-presence controls beside the player', () => {
    const common = {
      backHref: '/title/movie/example',
      backLabel: 'Back',
      sources: [],
      selectedSourceId: null,
      onSelectSource: vi.fn(),
      onReportIssue: vi.fn(),
    };
    const invite = renderToStaticMarkup(createElement(PlayerControlsBar, {
      ...common,
      watchParty: { available: true, active: false, participantCount: 0, onOpen: vi.fn() },
    }));
    const active = renderToStaticMarkup(createElement(PlayerControlsBar, {
      ...common,
      watchParty: { available: true, active: true, participantCount: 3, onOpen: vi.fn() },
    }));
    expect(invite).toContain('Invite / Join party');
    expect(active).toContain('Party chat (3)');
    expect(active).toContain('aria-haspopup="dialog"');
  });

  it('shows unavailable before any create, join, resume or retry control when the service is off', () => {
    const markup = renderToStaticMarkup(createElement(WatchPartyPanel, {
      open: true, onClose: vi.fn(), initialRoomCode: 'ABCDE23456',
      session: controller({ available: false, syncStatus: 'unavailable', state: INITIAL_WATCH_PARTY_STATE,
        savedResume: { v: 1, roomCode: 'ABCDE23456', participantId: MEMBER_ID, resumeToken: 'wp1.resume.signature', expiresAtMs: Date.now() + 1_000 } }),
    }));
    expect(markup).toContain('Watch Party unavailable');
    for (const text of ['Create party', 'Join room', 'Resume ABCDE23456', 'Retry connection', 'Chat is ready', 'synchronization is available']) {
      expect(markup).not.toContain(text);
    }
  });

  it('does not pretend that passing a declared native port prop registers a synchronization port', () => {
    const markup = renderToStaticMarkup(createElement(WatchPartyPanel, {
      open: true, onClose: vi.fn(), session: controller({ syncStatus: 'awaiting-player-port' }),
    }));
    expect(markup).toContain('Playback sync unavailable');
    expect(markup).toContain('registered synchronization port');
    expect(markup).not.toContain('Native playback synchronization is available');
    expect(markup).not.toContain('Chat is ready');
  });

  it.each(['reconnecting', 'error', 'leaving'] as const)('labels %s room state as stale and disables room controls', (phase) => {
    const session = controller({ syncStatus: 'ready', state: { ...controller().state, phase,
      self: { participantId: HOST_ID, role: 'host' } } });
    const markup = renderToStaticMarkup(createElement(WatchPartyPanel, { open: true, onClose: vi.fn(), session }));
    expect(markup).toContain('Last known: 2 connected');
    expect(markup).toContain('Playback sync and chat are paused until the room reconnects.');
    expect(markup).not.toContain('Native playback synchronization is available');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Make host<\/button>/);
    if (phase === 'error') expect(markup).toContain('Retry connection');
  });

  it('disables the initial party/report actions and acknowledges reports only after confirmed success', () => {
    const common = { backHref: '/title/movie/example', backLabel: 'Back', sources: [], selectedSourceId: null,
      onSelectSource: vi.fn(), onReportIssue: vi.fn(), watchParty: { available: false, active: false, participantCount: 0, onOpen: vi.fn() } };
    const unavailable = renderToStaticMarkup(createElement(PlayerControlsBar, common));
    expect(unavailable).toContain('Watch Party unavailable'); expect(unavailable).toContain('Reporting unavailable');
    expect(unavailable).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Watch Party unavailable/);
    expect(unavailable).not.toContain('recorded');
    const pending = renderToStaticMarkup(createElement(PlayerControlsBar, { ...common, reportingAvailable: true, reportPending: true }));
    expect(pending).toContain('Sending report...'); expect(pending).toContain('aria-busy="true"'); expect(pending).not.toContain('recorded');
    const failed = renderToStaticMarkup(createElement(PlayerControlsBar, { ...common, reportingAvailable: true, reportError: 'Your report could not be sent.' }));
    expect(failed).toContain('Your report could not be sent.'); expect(failed).not.toContain('recorded');
    const confirmed = renderToStaticMarkup(createElement(PlayerControlsBar, { ...common, reportingAvailable: true, reported: true }));
    expect(confirmed).toContain('your report was recorded');
  });
});
