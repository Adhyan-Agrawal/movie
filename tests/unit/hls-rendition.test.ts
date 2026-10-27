import { describe, expect, it } from 'vitest';
import { selectHlsRendition } from '@/lib/providers/hls-rendition';

const MASTER = [
  '#EXTM3U', '#EXT-X-VERSION:7',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",URI="audio.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="French",LANGUAGE="fr",URI="subs.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="audio",SUBTITLES="subs"',
  'hd.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160,AUDIO="audio",SUBTITLES="subs"',
  'uhd.m3u8',
].join('\n');

describe('fixed native HLS rendition', () => {
  it('keeps exactly the selected video variant and all language groups', () => {
    const selected = selectHlsRendition(MASTER, '1');
    expect(selected).toContain('uhd.m3u8');
    expect(selected).not.toContain('hd.m3u8\n#EXT');
    expect(selected?.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(1);
    expect(selected).toContain('TYPE=AUDIO');
    expect(selected).toContain('TYPE=SUBTITLES');
    expect(selected).toContain('AUDIO="audio",SUBTITLES="subs"');
  });

  it('rejects unknown, malformed, and media-playlist selections', () => {
    for (const id of ['-1', '1.5', 'auto', '01', '2', '1000']) expect(selectHlsRendition(MASTER, id)).toBeNull();
    expect(selectHlsRendition('#EXTM3U\n#EXTINF:6,\nsegment.ts', '0')).toBeNull();
  });

  it('uses the same complete-variant indexing as metadata when an invalid declaration is present', () => {
    const malformed = MASTER.replace('hd.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=123');
    const selected = selectHlsRendition(malformed, '0');
    expect(selected).toContain('uhd.m3u8');
    expect(selected?.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(1);
  });
});
