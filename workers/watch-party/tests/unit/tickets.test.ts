import { describe, expect, it } from 'vitest';
import {
  WATCH_PARTY_SUBPROTOCOL,
  WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX,
} from '@watch-party/protocol';
import {
  generateWatchPartyId,
  generateWatchPartyRoomCode,
  signWatchPartyToken,
  ticketFromWatchPartySubprotocol,
  verifyWatchPartyToken,
  watchPartySubprotocols,
  watchPartyTokenBase,
  type WatchPartyConnectTicketClaims,
  type WatchPartyResumeTokenClaims,
} from '@watch-party/tickets';

const SECRET = 'unit-test-watch-party-secret-at-least-32-characters';
const TITLE_ID = '10000000-0000-4000-8000-000000000001';

function createClaims(nowMs = Date.now()): WatchPartyConnectTicketClaims {
  return {
    ...watchPartyTokenBase({
      roomCode: generateWatchPartyRoomCode(),
      roomId: generateWatchPartyId(),
      participantId: generateWatchPartyId(),
      displayName: 'Host',
      platform: 'web',
      ttlSeconds: 120,
      nowMs,
    }),
    kind: 'connect',
    action: 'create',
    role: 'host',
    media: { kind: 'movie', mediaId: TITLE_ID },
  };
}

describe('Watch Party tickets', () => {
  it('uses cryptographic-format random room codes and identifiers', () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateWatchPartyRoomCode()));
    expect(codes.size).toBe(100);
    for (const code of codes) expect(code).toMatch(/^[A-HJ-KM-NP-TV-Z2-9]{10}$/);
    expect(generateWatchPartyId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('signs and verifies a bounded create ticket', async () => {
    const claims = createClaims();
    const token = await signWatchPartyToken(claims, SECRET);
    const verified = await verifyWatchPartyToken(token, SECRET, { expectedKind: 'connect' });
    expect(verified).toEqual({ ok: true, claims });
    expect(watchPartySubprotocols(token)).toEqual([
      WATCH_PARTY_SUBPROTOCOL,
      `${WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX}${token}`,
    ]);
    expect(ticketFromWatchPartySubprotocol(
      `${WATCH_PARTY_SUBPROTOCOL}, ${WATCH_PARTY_TICKET_SUBPROTOCOL_PREFIX}${token}`,
    )).toBe(token);
  });

  it('rejects tampering, a wrong secret, expiry, and future issuance', async () => {
    const now = Date.now();
    const token = await signWatchPartyToken(createClaims(now), SECRET);
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(await verifyWatchPartyToken(tampered, SECRET)).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifyWatchPartyToken(token, `${SECRET}-wrong`)).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifyWatchPartyToken(token, SECRET, { nowMs: now + 121_000 }))
      .toEqual({ ok: false, reason: 'expired' });
    const future = await signWatchPartyToken(createClaims(now + 60_000), SECRET);
    expect(await verifyWatchPartyToken(future, SECRET, { nowMs: now }))
      .toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  it('keeps resume tokens distinct from connection tickets', async () => {
    const create = createClaims();
    const resume: WatchPartyResumeTokenClaims = {
      ...watchPartyTokenBase({
        roomCode: create.roomCode,
        roomId: create.roomId!,
        participantId: create.participantId,
        displayName: create.displayName,
        platform: create.platform,
        ttlSeconds: 1_800,
      }),
      kind: 'resume',
      roomId: create.roomId!,
    };
    const token = await signWatchPartyToken(resume, SECRET);
    expect(await verifyWatchPartyToken(token, SECRET, { expectedKind: 'resume' })).toMatchObject({ ok: true });
    expect(await verifyWatchPartyToken(token, SECRET, { expectedKind: 'connect' }))
      .toEqual({ ok: false, reason: 'invalid' });
  });
});
