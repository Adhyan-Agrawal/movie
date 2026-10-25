import { describe, expect, it } from 'vitest';
import type { DirectStream } from '@/lib/providers/types';
import { aggregateStreamOptions, chooseStream, nominalQualityHeight, preferencesForStream, trackKey } from '@/features/player/stream-options';

const streams: DirectStream[] = [
  { id: 'hd', url: '/hd', qualities: [{ id: 'hd', label: 'HD', width: 1920, height: 800 }], audioTracks: [{ id: 'en', label: 'English', language: 'en' }], subtitles: [] },
  { id: 'uhd', url: '/uhd', qualities: [{ id: '4k', label: 'UHD', width: 3840, height: 1600 }, { id: 'hd', label: 'HD', width: 1920, height: 1080 }], audioTracks: [{ id: 'en', label: 'English', language: 'eng' }, { id: 'hi', label: 'Hindi', language: 'hi' }], subtitles: [{ id: 'en', label: 'English', language: 'en', kind: 'subtitles' }] },
  { id: 'dub', url: '/dub', qualities: [{ id: '720', label: '720p', width: 1280, height: 534 }], audioTracks: [{ id: 'ta', label: 'Tamil', language: 'ta' }], subtitles: [{ id: 'en', label: 'English', language: 'en', kind: 'subtitles' }] },
];

describe('unified stream options', () => {
  it('unions and deduplicates nominal qualities, audio languages and subtitles', () => {
    const options = aggregateStreamOptions(streams);
    expect(options.qualities.map((option) => option.label)).toEqual(['4K', '1080p', '720p']);
    expect(options.audioTracks.map((option) => option.label)).toEqual(['English', 'Hindi', 'Tamil']);
    expect(options.subtitles.map((option) => option.label)).toEqual(['English']);
  });

  it('labels letterboxed resolutions without presenting 800p or 1600p as separate qualities', () => {
    expect(nominalQualityHeight({ id: 'x', label: '', width: 1920, height: 800 })).toBe(1080);
    expect(nominalQualityHeight({ id: 'x', label: '', width: 3840, height: 1600 })).toBe(2160);
  });

  it('preserves genuine 4:3 and 16:9 raster heights', () => {
    expect(nominalQualityHeight({ id: 'x', label: '', width: 320, height: 240 })).toBe(240);
    expect(nominalQualityHeight({ id: 'x', label: '', width: 640, height: 480 })).toBe(480);
    expect(nominalQualityHeight({ id: 'x', label: '', width: 768, height: 576 })).toBe(576);
    expect(nominalQualityHeight({ id: 'x', label: '', width: 1920, height: 1080 })).toBe(1080);
  });

  it('switches to a stream that supplies the selected audio and preserves compatible preferences', () => {
    const preferences = { quality: 'quality:2160', audio: trackKey({ language: 'hi' }), subtitle: trackKey({ language: 'en' }) };
    const selected = chooseStream(streams, preferences, 'audio', 'hd');
    expect(selected?.id).toBe('uhd');
    expect(preferencesForStream(selected!, preferences)).toEqual(preferences);
  });

  it('honors newly selected audio when the old quality is unavailable instead of inventing that combination', () => {
    const preferences = { quality: 'quality:2160', audio: trackKey({ language: 'ta' }), subtitle: trackKey({ language: 'en' }) };
    const selected = chooseStream(streams, preferences, 'audio', 'uhd');
    expect(selected?.id).toBe('dub');
    expect(preferencesForStream(selected!, preferences).quality).toBe('auto');
  });

  it('does not advertise absent audio or subtitle tracks', () => {
    expect(aggregateStreamOptions([{ id: 'one', url: '/one', qualities: [], audioTracks: [], subtitles: [] }])).toEqual({ qualities: [], audioTracks: [], subtitles: [] });
    expect(chooseStream(streams, { quality: 'auto', audio: 'missing::', subtitle: 'off' }, 'audio')).toBeUndefined();
  });

  it('preserves distinct commentary and forced-caption roles', () => {
    expect(trackKey({ language: 'en', label: 'English commentary' })).not.toBe(trackKey({ language: 'en', label: 'English' }));
    expect(trackKey({ language: 'en', label: 'English forced' })).not.toBe(trackKey({ language: 'en', label: 'English' }));
  });

  it('prefers the fastest measured compatible source without forcing the highest rendition', () => {
    const measured = streams.map((stream) => ({ ...stream, startupLatencyMs: stream.id === 'hd' ? 80 : 900 }));
    expect(chooseStream(measured, { quality: 'auto', audio: trackKey({ language: 'en' }), subtitle: 'off' }, 'quality', 'uhd')?.id).toBe('hd');
    expect(chooseStream(measured, { quality: 'quality:2160', audio: trackKey({ language: 'en' }), subtitle: 'off' }, 'quality', 'hd')?.id).toBe('uhd');
  });

  it('does not prefer missing or invalid latency measurements over a healthy measured source', () => {
    const measured = streams.map((stream) => ({ ...stream, startupLatencyMs: stream.id === 'uhd' ? 120 : -1 }));
    expect(chooseStream(measured, { quality: 'auto', audio: trackKey({ language: 'en' }), subtitle: 'off' }, 'quality', 'hd')?.id).toBe('uhd');
  });
});
