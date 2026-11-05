import { describe, expect, it } from 'vitest';
import { parseTrailerInfo, publicTrailerUrl, trailerLookupPath, validImdbId } from '@/features/trailers/types';

const NOW = Date.UTC(2026, 10, 4, 12);
const media = (seconds = NOW / 1000 + 600) => `https://imdb-video.media-imdb.com/qa-synthetic.mp4?Expires=${seconds}`;
const info = () => ({ url: media(), previewUrl: media(), mime: 'video/mp4', name: 'Synthetic QA trailer', expiresAt: NOW + 300_000 });

describe('trailer lookup and public DTO boundaries', () => {
  it('accepts bounded IMDb IDs and uses only the same-origin lookup endpoint', () => {
    expect(validImdbId('tt9000001')).toBe(true);
    expect(validImdbId('tt123456789012')).toBe(true);
    expect(trailerLookupPath({ imdbId: 'tt9000001', tmdbId: '900001', type: 'movie' })).toBe('/api/trailer?imdbId=tt9000001');
  });

  it.each(['tt123456', 'tt1234567890123', 'TT9000001', 'tt9000001 ', ' tt9000001', 'tt9000001\n', '9000001', 'tt1e00000', '', null, 9000001])('rejects invalid IMDb input #%#', (value) => {
    expect(validImdbId(value)).toBe(false);
  });

  it('requires a valid TMDB ID and explicit movie/TV kind when IMDb is absent', () => {
    expect(trailerLookupPath({ tmdbId: '900001', type: 'movie' })).toBe('/api/trailer?tmdbId=900001&type=movie');
    expect(trailerLookupPath({ tmdbId: '900002', type: 'tv' })).toBe('/api/trailer?tmdbId=900002&type=tv');
    expect(trailerLookupPath({ tmdbId: '900001' })).toBeNull();
    for (const tmdbId of ['0', '01', '-1', '1e3', '1.5', '12345678901', '900001&url=bad', '900001\n']) {
      expect(trailerLookupPath({ tmdbId, type: 'movie' }) === null).toBe(true);
    }
  });

  it('allows direct trusted HTTPS MP4 without changing its origin or pathname', () => {
    const value = publicTrailerUrl(media());
    expect(Boolean(value)).toBe(true);
    const url = new URL(value!);
    expect(url.origin).toBe('https://imdb-video.media-imdb.com');
    expect(url.pathname).toBe('/qa-synthetic.mp4');
    expect(publicTrailerUrl('https://video.media-imdb.com/qa.MP4') !== null).toBe(true);
  });

  it.each([
    'http://imdb-video.media-imdb.com/qa.mp4',
    'https://imdb-video.media-imdb.com.attacker.invalid/qa.mp4',
    'https://attacker-media-imdb.com/qa.mp4',
    'https://media-imdb.com@attacker.invalid/qa.mp4',
    'https://user:password@imdb-video.media-imdb.com/qa.mp4',
    'https://imdb-video.media-imdb.com/qa.mp4#fragment',
    'https://127.0.0.1/qa.mp4', 'https://localhost/qa.mp4',
    'https://imdb-video.media-imdb.com/qa.m3u8',
    'https://imdb-video.media-imdb.com/qa.mp4\n',
    'https://imdb-video.media-imdb.com/qa.mp4\0',
    'javascript:alert(1)', 'data:video/mp4;base64,AAAA', '/api/vidnest?token=synthetic',
    '', null, 1,
  ])('rejects unsafe, private, non-MP4, or proxy URLs #%#', (value) => {
    expect(publicTrailerUrl(value) === null).toBe(true);
  });

  it('enforces the URL length boundary', () => {
    expect(publicTrailerUrl(`https://imdb-video.media-imdb.com/qa.mp4?padding=${'a'.repeat(4096)}`) === null).toBe(true);
  });

  it('returns only plain public fields and trims a bounded display name', () => {
    const parsed = parseTrailerInfo({ ...info(), name: '  Synthetic QA trailer  ', headers: { Authorization: 'synthetic' }, token: 'synthetic' }, NOW);
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['expiresAt', 'mime', 'name', 'previewUrl', 'url']);
    expect(parsed?.name).toBe('Synthetic QA trailer');
    expect(parseTrailerInfo({ ...info(), name: 'a'.repeat(200) }, NOW) !== null).toBe(true);
  });

  it.each([null, [], {}, { mime: 'text/html' }, { name: '' }, { name: ' ' }, { name: 'a'.repeat(201) }, { name: 'bad\nname' },
    { expiresAt: NOW }, { expiresAt: NOW - 1 }, { expiresAt: NOW + 3_600_001 }, { expiresAt: NOW + 0.5 }, { expiresAt: Infinity },
  ])('rejects malformed DTO fields #%#', (override) => {
    const input = override === null || Array.isArray(override) || Object.keys(override).length === 0 ? override : { ...info(), ...override };
    expect(parseTrailerInfo(input, NOW) === null).toBe(true);
  });

  it('rejects already expired MP4 signatures even if the DTO expiry claims freshness', () => {
    expect(parseTrailerInfo({ ...info(), url: media(NOW / 1000 - 1) }, NOW) === null).toBe(true);
    expect(parseTrailerInfo({ ...info(), previewUrl: media(NOW / 1000 - 1) }, NOW) === null).toBe(true);
  });

  it('does not accept a DTO cache expiry later than either signed media expiry', () => {
    expect(parseTrailerInfo({ ...info(), previewUrl: media(NOW / 1000 + 60) }, NOW) === null).toBe(true);
  });
});
