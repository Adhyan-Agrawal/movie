import { describe, expect, it } from 'vitest';
import { httpsUrl, metadataLabel, parseHlsMetadata } from '@/lib/providers/hls-metadata';

describe('VidNest HLS metadata parser', () => {
  it('parses real quality variants including width and average bitrate', () => {
    const metadata = parseHlsMetadata([
      '\uFEFF#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4200000,RESOLUTION=1920x800,CODECS="avc1,mp4a"',
      '1080/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x1600',
      '4k/index.m3u8',
    ].join('\r\n'));
    expect(metadata.qualities).toEqual([
      { id: '0', label: '800p', width: 1920, height: 800, bitrateKbps: 4200 },
      { id: '1', label: '1600p', width: 3840, height: 1600, bitrateKbps: 12000 },
    ]);
    expect(metadata.audioTracks).toEqual([]);
    expect(metadata.subtitles).toEqual([]);
  });

  it('parses quoted commas, actual audio, subtitle and caption renditions without exposing their URIs', () => {
    const metadata = parseHlsMetadata([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English, commentary",LANGUAGE="en",DEFAULT=YES,URI="private/audio.m3u8?token=secret"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French",LANGUAGE="fr"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English SDH",LANGUAGE="en",DEFAULT=YES,URI="private/subs.m3u8"',
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="French CC",LANGUAGE="fr",INSTREAM-ID="CC1"',
    ].join('\n'));
    expect(metadata.audioTracks).toEqual([
      { id: '0', label: 'English, commentary', language: 'en', default: true },
      { id: '1', label: 'French', language: 'fr' },
    ]);
    expect(metadata.subtitles).toEqual([
      { id: '0', label: 'English SDH', language: 'en', default: true, kind: 'subtitles' },
      { id: '1', label: 'French CC', language: 'fr', kind: 'captions' },
    ]);
    expect(JSON.stringify(metadata)).not.toContain('private');
  });

  it.each(['', '<html>Unavailable</html>', '#EXTM3U\n#EXTINF:6,\nsegment.ts'])('never invents quality, language, or audio for %s', (body) => {
    expect(parseHlsMetadata(body)).toEqual({ qualities: [], audioTracks: [], subtitles: [] });
  });

  it('keeps an existing unnamed rendition without inventing its language', () => {
    const metadata = parseHlsMetadata('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="",LANGUAGE="https://secret.example"');
    expect(metadata.audioTracks).toEqual([{ id: '0', label: 'Audio 1', language: '' }]);
  });

  it('rejects unsafe metadata labels and source URL schemes/credentials', () => {
    expect(metadataLabel('https://private.example/file?token=secret')).toBe('');
    expect(metadataLabel('x'.repeat(81))).toBe('');
    expect(metadataLabel(' English\n')).toBe('English');
    expect(httpsUrl('javascript:alert(1)')).toBeUndefined();
    expect(httpsUrl('http://media.example/stream')).toBeUndefined();
    expect(httpsUrl('https://user:secret@media.example/stream')).toBeUndefined();
    expect(httpsUrl('../sub.vtt', 'https://media.example/movie/master.m3u8')).toBe('https://media.example/sub.vtt');
  });
});
