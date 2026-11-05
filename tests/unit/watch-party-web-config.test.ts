import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCH_PARTY_LIMITS, WATCH_PARTY_SUBPROTOCOL } from '@/features/watch-party/protocol';
import { signWatchPartyToken, verifyWatchPartyToken, watchPartyTokenBase } from '@/features/watch-party/tickets';

vi.mock('server-only', () => ({}));

import { isWatchPartyConfigured, watchPartyServerConfig } from '@/app/api/watch-party/config';
import { GET, POST } from '@/app/api/watch-party/route';

const SECRET = 'fixture-only-watch-party-secret-32-characters';
const APP_ORIGIN = 'https://app.example';
const MEDIA_ID = '10000000-0000-4000-8000-000000000001';
const environment: NodeJS.ProcessEnv = { NODE_ENV: 'production', WATCH_PARTY_SECRET: SECRET,
  WATCH_PARTY_WORKER_URL: 'https://party.example', NEXT_PUBLIC_APP_URL: APP_ORIGIN };

function request(body: unknown, origin = APP_ORIGIN): Request {
  return new Request(`${APP_ORIGIN}/api/watch-party`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.stubEnv('WATCH_PARTY_SECRET', SECRET); vi.stubEnv('WATCH_PARTY_WORKER_URL', 'https://party.example');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_ORIGIN);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('server-validated nonsecret Watch Party availability', () => {
  it('derives only a boolean from the exact ticket configuration and permits explicit local development', () => {
    expect(isWatchPartyConfigured(environment)).toBe(true);
    expect(watchPartyServerConfig(environment)).toEqual({ secret: SECRET, websocketUrl: 'wss://party.example/v1/ws', canonicalAppOrigin: APP_ORIGIN });
    expect(watchPartyServerConfig({ ...environment, NODE_ENV: 'development', WATCH_PARTY_WORKER_URL: 'http://localhost:8787',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3100' }).websocketUrl).toBe('ws://localhost:8787/v1/ws');
  });

  it.each([
    ['missing secret', { WATCH_PARTY_SECRET: undefined }],
    ['empty secret', { WATCH_PARTY_SECRET: '' }],
    ['short secret', { WATCH_PARTY_SECRET: 'too-short' }],
    ['secret newline', { WATCH_PARTY_SECRET: `${SECRET}\n` }],
    ['missing URL', { WATCH_PARTY_WORKER_URL: undefined }],
    ['empty URL', { WATCH_PARTY_WORKER_URL: '' }],
    ['invalid URL', { WATCH_PARTY_WORKER_URL: 'invalid' }],
    ['URL whitespace', { WATCH_PARTY_WORKER_URL: ' https://party.example' }],
    ['URL credentials', { WATCH_PARTY_WORKER_URL: 'https://user:password@party.example' }],
    ['URL path', { WATCH_PARTY_WORKER_URL: 'https://party.example/private' }],
    ['URL query', { WATCH_PARTY_WORKER_URL: 'https://party.example?token=private' }],
    ['URL fragment', { WATCH_PARTY_WORKER_URL: 'https://party.example#fragment' }],
    ['insecure production URL', { WATCH_PARTY_WORKER_URL: 'http://localhost:8787' }],
    ['invalid app origin', { NEXT_PUBLIC_APP_URL: 'https://app.example/path' }],
  ])('fails closed for %s without manufacturing a service URL', (_name, override) => {
    expect(isWatchPartyConfigured({ ...environment, ...override })).toBe(false);
    expect(() => watchPartyServerConfig({ ...environment, ...override })).toThrow();
  });

  it('keeps unconfigured config and ticket endpoints unavailable without returning credentials', async () => {
    vi.stubEnv('WATCH_PARTY_SECRET', ''); vi.stubEnv('WATCH_PARTY_WORKER_URL', '');
    for (const response of [await GET(), await POST(request({ v: 1, action: 'join', platform: 'web', displayName: 'Viewer', roomCode: 'ABCDE23456' }))]) {
      expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toContain('no-store');
      const body = await response.json(); expect(body).toMatchObject({ v: 1, error: { code: 'INTERNAL_ERROR' } });
      expect(body).not.toHaveProperty('ticket'); expect(body).not.toHaveProperty('websocketUrl');
      expect(JSON.stringify(body)).not.toContain(SECRET);
    }
  });

  it('preserves configured config, create/join tickets and same-origin enforcement', async () => {
    const config = await GET(); expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({ v: 1, websocketUrl: 'wss://party.example/v1/ws', subprotocol: WATCH_PARTY_SUBPROTOCOL });
    const created = await POST(request({ v: 1, action: 'create', platform: 'web', displayName: 'Viewer', media: { kind: 'movie', mediaId: MEDIA_ID }, positionSeconds: 12 }));
    expect(created.status).toBe(201); const body = await created.json();
    expect(body.subprotocols).toEqual([WATCH_PARTY_SUBPROTOCOL, `lumora.ticket.${body.ticket}`]);
    expect(body).not.toHaveProperty('secret');
    expect(await verifyWatchPartyToken(body.ticket, SECRET, { expectedKind: 'connect' })).toMatchObject({ ok: true,
      claims: { kind: 'connect', action: 'create', role: 'host', media: { kind: 'movie', mediaId: MEDIA_ID }, positionSeconds: 12 } });
    const joined = await POST(request({ v: 1, action: 'join', platform: 'web', displayName: 'Viewer', roomCode: body.roomCode }));
    expect(joined.status).toBe(200);
    expect(await verifyWatchPartyToken((await joined.json()).ticket, SECRET, { expectedKind: 'connect' })).toMatchObject({ ok: true, claims: { action: 'join', role: 'member' } });
    expect((await POST(request({ v: 1, action: 'join', platform: 'web', displayName: 'Viewer', roomCode: body.roomCode }, 'https://other.example'))).status).toBe(403);
  });

  it('preserves authenticated resume tickets while rejecting virtual TMDB media identities', async () => {
    const resumeToken = await signWatchPartyToken({ ...watchPartyTokenBase({ roomCode: 'ABCDE23456', roomId: MEDIA_ID,
      participantId: MEDIA_ID, displayName: 'Viewer', platform: 'web', ttlSeconds: WATCH_PARTY_LIMITS.resumeTtlSeconds }), kind: 'resume', roomId: MEDIA_ID }, SECRET);
    const resumed = await POST(request({ v: 1, action: 'resume', platform: 'web', resumeToken }));
    expect(resumed.status).toBe(200);
    expect(await verifyWatchPartyToken((await resumed.json()).ticket, SECRET)).toMatchObject({ ok: true, claims: { action: 'resume', roomId: MEDIA_ID, participantId: MEDIA_ID } });
    const unsupported = await POST(request({ v: 1, action: 'create', platform: 'web', displayName: 'Viewer', media: { kind: 'movie', mediaId: 'tmdb:movie:123' } }));
    expect(unsupported.status).toBe(400); expect(await unsupported.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });
});
