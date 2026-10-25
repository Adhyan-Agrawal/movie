import { describe, expect, it } from 'vitest';
import { createSubtitleToken, normalizeSubtitleCatalog, readSubtitleToken, tracksWithTokens } from '@/features/player/wyzie-subtitles';

const SECRET = 'subtitle-test-secret-at-least-32-characters';
const NOW = Date.UTC(2026, 9, 25);

describe('Wyzie subtitle normalization', () => {
  it('keeps valid tracks, caps variants, and separates standard captions from SDH', () => {
    const input = Array.from({ length: 6 }, (_, index) => ({
      id: `en-${index}`, url: `https://sub.wyzie.io/c/${index}`,
      language: 'en', display: 'English', release: `WEB ${index}`,
      isHearingImpaired: index === 1,
    }));
    const tracks = normalizeSubtitleCatalog(input);
    expect(tracks).toHaveLength(3);
    expect(tracks.map((track) => track.kind)).toContain('captions');
    expect(tracks[1]?.label).toContain('SDH');
  });

  it('rejects unsafe, credentialed, non-Wyzie and malformed subtitle URLs', () => {
    const tracks = normalizeSubtitleCatalog([
      { id: 'http', url: 'http://sub.wyzie.io/c/1', language: 'en' },
      { id: 'other', url: 'https://evil.example/c/1', language: 'en' },
      { id: 'credentials', url: 'https://user:pass@sub.wyzie.io/c/1', language: 'en' },
      { id: 'valid', url: 'https://sub.wyzie.io/c/1', language: 'en', display: 'English' },
    ]);
    expect(tracks.map((track) => track.id)).toEqual(['valid']);
  });

  it('does not leak the upstream URL in same-origin catalog tracks', () => {
    const normalized = normalizeSubtitleCatalog([
      { id: 'one', url: 'https://sub.wyzie.io/c/private-token', language: 'en', display: 'English' },
    ]);
    const [track] = tracksWithTokens(normalized, SECRET, NOW);
    expect(track?.url).toMatch(/^\/api\/subtitles\?token=/);
    expect(track?.url).not.toContain('sub.wyzie.io');
    expect(track?.url).not.toContain('private-token');
  });
});

describe('Wyzie subtitle tokens', () => {
  it('round-trips encrypted URLs until expiration', () => {
    const token = createSubtitleToken('https://sub.wyzie.io/c/private-token', SECRET, NOW);
    expect(token).not.toContain('private-token');
    expect(readSubtitleToken(token, SECRET, NOW + 1)).toEqual({
      url: 'https://sub.wyzie.io/c/private-token', expiresAt: NOW + 4 * 60 * 60 * 1000,
    });
    expect(readSubtitleToken(token, SECRET, NOW + 4 * 60 * 60 * 1000)).toBeNull();
  });

  it('rejects tampering, wrong secrets and unsafe source URLs', () => {
    const token = createSubtitleToken('https://sub.wyzie.io/c/one', SECRET, NOW);
    expect(readSubtitleToken(`${token.slice(0, -1)}x`, SECRET, NOW)).toBeNull();
    expect(readSubtitleToken(token, `${SECRET}-wrong`, NOW)).toBeNull();
    expect(() => createSubtitleToken('https://private.example/c/one', SECRET, NOW)).toThrow();
  });
});
