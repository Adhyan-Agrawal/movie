import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/watch-party/route';
import { WATCH_PARTY_SUBPROTOCOL } from '@watch-party/protocol';
import {
  generateWatchPartyId,
  signWatchPartyToken,
  verifyWatchPartyToken,
  watchPartyTokenBase,
} from '@watch-party/tickets';

const SECRET = 'route-test-watch-party-secret-at-least-32-characters';
const TITLE_ID = '10000000-0000-4000-8000-000000000001';

function configure(): void {
  vi.stubEnv('WATCH_PARTY_SECRET', SECRET);
  vi.stubEnv('WATCH_PARTY_WORKER_URL', 'https://watch.example.com');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com');
  vi.stubEnv('NODE_ENV', 'production');
}

function ticketRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://app.example.com/api/watch-party', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('Watch Party ticket API', () => {
  it('returns only public config and the frozen drift contract', async () => {
    configure();
    const result = await GET();
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      v: 1,
      websocketUrl: 'wss://watch.example.com/v1/ws',
      subprotocol: WATCH_PARTY_SUBPROTOCOL,
      ticketTtlSeconds: 120,
      drift: { noCorrectionSeconds: 0.25, correctionExitSeconds: 0.1, hardSyncSeconds: 1.5 },
    });
  });

  it('retains canonical episode coordinates when an episode UUID is unavailable', async () => {
    configure();
    const result = await POST(ticketRequest({
      v: 1,
      action: 'create',
      platform: 'android',
      displayName: 'Host',
      media: { kind: 'episode', mediaId: TITLE_ID, seasonNumber: 0, episodeNumber: 2 },
    }));
    expect(result.status).toBe(201);
    const body = await result.json() as { ticket: string };
    const verified = await verifyWatchPartyToken(body.ticket, SECRET, { expectedKind: 'connect' });
    expect(verified.ok && verified.claims.kind === 'connect' ? verified.claims.media : null)
      .toEqual({ kind: 'episode', mediaId: TITLE_ID, seasonNumber: 0, episodeNumber: 2 });
    const invalid = await POST(ticketRequest({
      v: 1,
      action: 'create',
      platform: 'android',
      displayName: 'Host',
      media: { kind: 'episode', mediaId: TITLE_ID, seasonNumber: 0 },
    }));
    expect(invalid.status).toBe(400);
  });

  it('mints a server-assigned host create ticket for same-origin web', async () => {
    configure();
    const result = await POST(ticketRequest({
      v: 1,
      action: 'create',
      platform: 'web',
      displayName: '<Host>',
      media: { kind: 'movie', mediaId: TITLE_ID },
    }, { Origin: 'https://app.example.com' }));
    expect(result.status).toBe(201);
    const body = await result.json() as { ticket: string; roomCode: string; participantId: string; subprotocols: string[] };
    expect(body.roomCode).toMatch(/^[A-HJ-KM-NP-TV-Z2-9]{10}$/);
    expect(body.subprotocols[0]).toBe(WATCH_PARTY_SUBPROTOCOL);
    const verified = await verifyWatchPartyToken(body.ticket, SECRET, { expectedKind: 'connect' });
    expect(verified.ok).toBe(true);
    if (verified.ok && verified.claims.kind === 'connect') {
      expect(verified.claims).toMatchObject({ action: 'create', role: 'host', displayName: '\u2039Host\u203a' });
      expect(verified.claims.roomId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('mints member join tickets for originless Android and rejects role injection', async () => {
    configure();
    const result = await POST(ticketRequest({
      v: 1,
      action: 'join',
      platform: 'android',
      displayName: 'Viewer',
      roomCode: 'abcde-23456',
    }));
    expect(result.status).toBe(200);
    const body = await result.json() as { ticket: string };
    const verified = await verifyWatchPartyToken(body.ticket, SECRET, { expectedKind: 'connect' });
    expect(verified.ok && verified.claims.kind === 'connect' ? verified.claims.role : null).toBe('member');
    const injected = await POST(ticketRequest({
      v: 1, action: 'join', platform: 'android', displayName: 'Viewer', roomCode: 'ABCDE23456', role: 'host',
    }));
    expect(injected.status).toBe(400);
  });

  it('rejects cross-origin web, browser-origin native, oversized, and unknown schema', async () => {
    configure();
    const body = { v: 1, action: 'join', platform: 'web', displayName: 'Viewer', roomCode: 'ABCDE23456' };
    expect((await POST(ticketRequest(body, { Origin: 'https://evil.example' }))).status).toBe(403);
    expect((await POST(ticketRequest({ ...body, platform: 'android' }, { Origin: 'https://app.example.com' }))).status).toBe(403);
    const unknown = await POST(ticketRequest({ ...body, extra: true }, { Origin: 'https://app.example.com' }));
    expect(unknown.status).toBe(400);
    const oversized = ticketRequest({ ...body, displayName: 'x'.repeat(9_000) }, {
      Origin: 'https://app.example.com', 'Content-Length': '9001',
    });
    expect((await POST(oversized)).status).toBe(413);
  });

  it('exchanges a valid self-only resume token for a fresh short-lived connection ticket', async () => {
    configure();
    const roomId = generateWatchPartyId();
    const participantId = generateWatchPartyId();
    const resumeToken = await signWatchPartyToken({
      ...watchPartyTokenBase({ roomCode: 'ABCDE23456', roomId, participantId, displayName: 'Viewer',
        platform: 'android', ttlSeconds: 1_800 }),
      kind: 'resume',
      roomId,
    }, SECRET);
    const result = await POST(ticketRequest({ v: 1, action: 'resume', platform: 'android', resumeToken }));
    expect(result.status).toBe(200);
    const body = await result.json() as { ticket: string; participantId: string };
    expect(body.participantId).toBe(participantId);
    const verified = await verifyWatchPartyToken(body.ticket, SECRET, { expectedKind: 'connect' });
    expect(verified.ok && verified.claims.kind === 'connect' ? verified.claims.action : null).toBe('resume');
  });
});
