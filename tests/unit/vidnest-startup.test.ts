import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { decodedAudioTracks, hasHlsPlaybackUri, hlsStartupPlan, parseMp4AudioLanguages } from '@/lib/providers/hls-metadata';

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8); header.write(type, 4, 'ascii');
  return new Uint8Array(Buffer.concat([header, payload]));
}

function mp4Track(language: string, handler: string, version = 0): Uint8Array {
  const mdhd = new Uint8Array(version ? 36 : 24);
  mdhd[0] = version;
  const packed = language === 'legacy-English' ? 0
    : Array.from(language, (value) => value.charCodeAt(0) - 96).reduce((bits, value) => (bits << 5) | value, 0);
  new DataView(mdhd.buffer).setUint16(version ? 32 : 20, packed);
  const hdlr = new Uint8Array(16);
  hdlr.set(new TextEncoder().encode(handler), 8);
  return box('trak', box('mdia', box('mdhd', mdhd), box('hdlr', hdlr)));
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('VidNest bounded startup plan', () => {
  it('validates playable encrypted and HEVC manifests independently of benchmark support', () => {
    for (const playlist of [
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nvideo.ts',
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="hvc1"\nvideo.m3u8',
    ]) {
      expect(hasHlsPlaybackUri(playlist, 'https://cdn.example/master.m3u8', () => true)).toBe(true);
      expect(hlsStartupPlan(playlist, 'https://cdn.example/master.m3u8')).toBeUndefined();
    }
  });

  it('requires real playback references and applies the supplied URL guard to key and media URIs', () => {
    expect(hasHlsPlaybackUri('#EXTM3U', 'https://cdn.example/master.m3u8', () => true)).toBe(false);
    expect(hasHlsPlaybackUri('#EXTM3U\n#EXTINF:6,\nhttp://insecure.example/video.ts', 'https://cdn.example/master.m3u8', () => true)).toBe(false);
    expect(hasHlsPlaybackUri('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://private.example/key"\n#EXTINF:6,\nvideo.ts',
      'https://cdn.example/master.m3u8', (url) => !url.includes('private.example'))).toBe(false);
  });

  it('selects a low AVC-compatible variant rather than an HEVC-only or high-bitrate rendition', () => {
    expect(hlsStartupPlan([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360,CODECS="hvc1"', 'hevc.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028"', 'high.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.42e01e"', 'low.m3u8',
    ].join('\n'), 'https://cdn.example/master.m3u8')).toEqual({ variantUrl: 'https://cdn.example/low.m3u8' });
  });

  it('preserves bounded media/init byte offsets without exposing keys', () => {
    expect(hlsStartupPlan([
      '#EXTM3U', '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MAP:URI="video.mp4",BYTERANGE="800@0"',
      '#EXTINF:6,', '#EXT-X-BYTERANGE:9000@800', 'video.mp4',
    ].join('\n'), 'https://cdn.example/movie/index.m3u8')).toEqual({
      media: { url: 'https://cdn.example/movie/video.mp4', offset: 800, length: 9000 },
      init: { url: 'https://cdn.example/movie/video.mp4', offset: 0, length: 800 },
    });
  });

  it.each([
    '<html>error</html>', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://insecure.example/video.m3u8',
    '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="private.key"\n#EXTINF:6,\nvideo.ts',
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="private.key"\n#EXTINF:6,\nvideo.ts',
    '#EXTM3U\n#EXTINF:6,\n#EXT-X-BYTERANGE:100\nvideo.mp4',
  ])('rejects unverified, encrypted, unsafe, or ambiguous startup data (%s)', (playlist) => {
    expect(hlsStartupPlan(playlist, 'https://cdn.example/master.m3u8')).toBeUndefined();
  });
});

describe('bounded fMP4 audio language decoding', () => {
  it.each([0, 1])('decodes mdhd version %i only when its track handler is audio', (version) => {
    const init = box('moov', mp4Track('hin', 'vide', version), mp4Track('eng', 'soun', version));
    expect(parseMp4AudioLanguages(init)).toEqual({ complete: true, audioLanguages: ['eng'] });
  });

  it('preserves separate audio tracks and does not synthesize undetermined languages', () => {
    expect(parseMp4AudioLanguages(box('moov', mp4Track('eng', 'soun'), mp4Track('hin', 'soun'), mp4Track('und', 'soun'))))
      .toEqual({ complete: true, audioLanguages: ['eng', 'hin'] });
  });

  it('decodes explicit legacy English without treating ISO und or absent language fields as English', () => {
    expect(parseMp4AudioLanguages(box('moov', mp4Track('legacy-English', 'soun'), mp4Track('und', 'soun'))))
      .toEqual({ complete: true, audioLanguages: ['eng'] });
    const handler = new Uint8Array(16); handler.set(new TextEncoder().encode('soun'), 8);
    expect(parseMp4AudioLanguages(box('moov', box('trak', box('mdia', box('mdhd', new Uint8Array(20)), box('hdlr', handler))))))
      .toEqual({ complete: true, audioLanguages: [] });
  });

  it('rejects truncated or corrupt box sizes and never reads past 64 KiB', () => {
    const init = box('moov', mp4Track('eng', 'soun'));
    expect(parseMp4AudioLanguages(init.subarray(0, -1))).toEqual({ complete: false, audioLanguages: [] });
    const corrupt = init.slice(); new DataView(corrupt.buffer).setUint32(0, 4);
    expect(parseMp4AudioLanguages(corrupt)).toEqual({ complete: false, audioLanguages: [] });
    expect(parseMp4AudioLanguages(new Uint8Array(Buffer.concat([box('free', new Uint8Array(64 * 1024)), init]))))
      .toEqual({ complete: false, audioLanguages: [] });
  });

  it('uses stable decoded track IDs and safe labels even without ICU language display names', () => {
    vi.stubGlobal('Intl', { DisplayNames: class { constructor() { throw new Error('Unavailable'); } } });
    expect(decodedAudioTracks(['eng', 'hin', 'zzz'])).toEqual([
      { id: 'decoded:eng:0', language: 'eng', label: 'English', default: true },
      { id: 'decoded:hin:1', language: 'hin', label: 'Hindi' },
      { id: 'decoded:zzz:2', language: 'zzz', label: 'ZZZ' },
    ]);
  });

  it('catalogs real fMP4 init audio, cancels within 64 KiB, and still verifies the media', async () => {
    vi.resetModules();
    vi.stubEnv('VIDNEST_API_SECRET', 'vidnest-mp4-test-secret-at-least-32-characters');
    vi.stubEnv('VIDNEST_API_URL', 'https://resolver.example');
    const cancel = vi.fn();
    const ranges: string[] = [];
    const initBytes = new Uint8Array(Buffer.concat([box('ftyp', new Uint8Array(8)),
      box('moov', mp4Track('hin', 'vide'), mp4Track('legacy-English', 'soun'))]));
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.pathname === '/api/resolve') return new Response(JSON.stringify({ streams: [{ url: 'https://cdn.example/media.m3u8' }] }));
      if (target.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment.m4s');
      ranges.push(new Headers(init?.headers).get('range')!);
      return target.pathname.endsWith('init.mp4')
        ? new Response(new ReadableStream({ start(controller) { controller.enqueue(initBytes); }, cancel }))
        : new Response(box('moof'));
    }));
    const { GET } = await import('@/app/api/vidnest/route');
    const response = await GET(new NextRequest('https://app.example/api/vidnest?tmdbId=27205&type=movie&metadata=1'));
    const body = await response.json();
    expect(body.streams[0].audioTracks).toEqual([{ id: 'decoded:eng:0', language: 'eng', label: 'English', default: true }]);
    expect(body.streams[0].startupLatencyMs).toEqual(expect.any(Number));
    expect(ranges).toEqual(['bytes=0-65535', 'bytes=0-1023']);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
