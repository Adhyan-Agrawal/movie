import { describe, expect, it } from 'vitest';
import { hasHlsPlaybackUri, hlsStartupPlan } from '@/lib/providers/hls-metadata';

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
