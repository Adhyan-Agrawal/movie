import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectStream } from '../../mobile/src/lib/types';
import { audioStreamOptions, chooseStream, compatiblePreferences, DEFAULT_PREFERENCES, hasAdaptiveQualities, qualityHeight, qualityKey, renditionUrl,
  streamPlaybackUrl, trackKey } from '../../mobile/src/player/options';
import { doubleTap, parseVtt, subtitleText } from '../../mobile/src/player/subtitles';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
  };
});
const orientation = vi.hoisted(() => ({
  OrientationLock: { DEFAULT: 0, LANDSCAPE: 5 },
  getPlatformOrientationLockAsync: vi.fn(async () => ({ screenOrientationConstantAndroid: 1 })),
  lockAsync: vi.fn(async () => {}), lockPlatformAsync: vi.fn(async () => {}),
}));
vi.mock('../../mobile/node_modules/@react-native-async-storage/async-storage', () => ({ default: storage }));
vi.mock('../../mobile/node_modules/expo-screen-orientation', () => orientation);

import { markCheckpointSynced, mediaKey, readCheckpoint, selectResume, validCheckpoint, writeCheckpoint } from '../../mobile/src/player/checkpoint';
import { getGuestResume, readGuestEntries, recordGuestWatch, updateGuestPosition } from '../../mobile/src/lib/guest';
import { acquireOrientation } from '../../mobile/src/player/orientation';
import { OrientationLock } from '../../mobile/node_modules/expo-screen-orientation';

const stream = (id: string, latency: number | undefined, height: number, language = 'en', subtitle = 'en'): DirectStream => ({
  id, url: `https://example.test/api/vidnest?token=${id}`, startupLatencyMs: latency,
  qualities: [{ id: '0', label: `${height}p`, height }],
  audioTracks: [{ id: '0', label: language, language }],
  subtitles: [{ id: '0', label: subtitle, language: subtitle }],
});

describe('Android stream preferences and capabilities', () => {
  it('Auto selects the lowest measured latency at ANY resolution, not the highest quality', () => {
    const candidates = [stream('4k', 800, 2160), stream('sd', 15, 240), stream('unknown', undefined, 720)];
    expect(chooseStream(candidates, DEFAULT_PREFERENCES, 'quality')?.id).toBe('sd');
  });
  it('an explicit quality wins, preserving compatible manual audio/subtitles before latency', () => {
    const candidates = [stream('slow', 500, 1080, 'hi', 'fr'), stream('fast', 10, 1080), stream('sd', 5, 240)];
    const prefs = { quality: 'quality:1080', audio: trackKey({ language: 'hi', label: 'hi' }), subtitle: trackKey({ language: 'fr', label: 'fr' }) };
    expect(chooseStream(candidates, prefs, 'quality')?.id).toBe('slow');
  });
  it('never substitutes manual quality, audio or subtitle pins when metadata is incompatible', () => {
    const s = stream('a', 10, 720);
    expect(compatiblePreferences(s, { quality: 'quality:2160', audio: 'de::', subtitle: 'fr::' }))
      .toEqual({ quality: 'quality:2160', audio: 'de::', subtitle: 'fr::' });
    expect(streamPlaybackUrl(s, { ...DEFAULT_PREFERENCES, quality: 'quality:2160' }, s.url)).toBeNull();
    expect(compatiblePreferences(s, { quality: 'auto', audio: '', subtitle: 'sidecar:release1' }).subtitle).toBe('sidecar:release1');
  });
  it('prefers a real adaptive master over a faster fixed 4K-only stream for Auto', () => {
    const fixed = stream('fixed-4k', 1, 2160);
    const adaptive = { ...stream('adaptive', 100, 360), qualities: [360, 720, 1080, 2160].map((height) => ({ id: String(height), label: `${height}p`, height })) };
    expect(hasAdaptiveQualities(fixed)).toBe(false); expect(hasAdaptiveQualities(adaptive)).toBe(true);
    expect(chooseStream([fixed, adaptive], DEFAULT_PREFERENCES, 'quality')?.id).toBe('adaptive');
    expect(streamPlaybackUrl(adaptive, DEFAULT_PREFERENCES, fixed.url)).toBe(adaptive.url);
    expect(new URL(streamPlaybackUrl(adaptive, DEFAULT_PREFERENCES, fixed.url)!).searchParams.has('rendition')).toBe(false);
  });
  it('unknown/invalid latency cannot beat measured healthy startup', () => {
    expect(chooseStream([stream('negative', -1, 2160), stream('nan', NaN, 2160), stream('valid', 0, 480)], DEFAULT_PREFERENCES, 'quality')?.id).toBe('valid');
  });
  it('quality grouping preserves real 4:3 and groups letterboxed UHD truthfully', () => {
    expect(qualityHeight({ id: '0', label: '', width: 320, height: 240 })).toBe(240);
    expect(qualityHeight({ id: '0', label: '', width: 768, height: 576 })).toBe(576);
    expect(qualityKey({ id: '0', label: '', width: 3840, height: 1600 })).toBe('quality:2160');
  });
  it('normalizes language aliases without erasing commentary/channel roles', () => {
    expect(trackKey({ language: 'eng', label: 'English' })).toBe(trackKey({ language: 'en', label: 'English' }));
    expect(trackKey({ language: 'en', label: 'English commentary 5.1' })).not.toBe('en::');
  });
  it('requests fixed quality through the original capability and resets Auto to its master', () => {
    const master = 'https://example.test/api/vidnest?token=opaque%2Bcapability';
    const fixed = new URL(renditionUrl(master, { id: '2', label: '1080p' }));
    expect(fixed.searchParams.get('token')).toBe('opaque+capability');
    expect(fixed.searchParams.get('rendition')).toBe('2');
    expect(renditionUrl(master)).toBe(master);
    expect(renditionUrl('https://example.test/video.m3u8', { id: '2', label: '1080p' })).toBe('https://example.test/video.m3u8');
  });
  it('Auto removes an existing rendition without changing the token or other capability parameters', () => {
    const fixed = 'https://example.test/api/vidnest?token=opaque%2Btoken&cast=1&rendition=2';
    const auto = new URL(renditionUrl(fixed));
    expect(auto.searchParams.has('rendition')).toBe(false);
    expect(auto.searchParams.get('token')).toBe('opaque+token');
    expect(auto.searchParams.get('cast')).toBe('1');
    expect(new URL(renditionUrl(fixed, { id: 'auto', label: 'Auto', auto: true })).searchParams.has('rendition')).toBe(false);
  });
  it('manual nominal quality resolves to the selected snapshot raw variant ID, not a quality label', () => {
    const candidate = { ...stream('snapshot', 10, 1080), qualities: [
      { id: '0', label: '720p', height: 720 }, { id: '3', label: '1080p', height: 1080 },
    ] };
    const prefs = { ...DEFAULT_PREFERENCES, quality: 'quality:1080' };
    const selected = chooseStream([candidate, stream('other', 50, 1080)], prefs, 'quality')!;
    const quality = selected.qualities.find((q) => qualityKey(q) === prefs.quality);
    const url = new URL(renditionUrl(selected.url, quality));
    expect(url.searchParams.get('token')).toBe('snapshot');
    expect(url.searchParams.get('rendition')).toBe('3');
    expect(selected.url).not.toContain('rendition');
  });
  it('numbers every actual catalog stream in order without deduplicating metadata or fabricating language labels', () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      ...stream(`snapshot-${index}`, index === 0 ? 1 : undefined, 720),
      ...(index % 2 ? { qualities: [], audioTracks: [], subtitles: [] } : {}),
    }));
    const choices = audioStreamOptions(candidates);
    expect(choices.map((choice) => choice.label)).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
    expect(choices.map((choice) => choice.number)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    choices.forEach((choice, index) => expect(choice.stream).toBe(candidates[index]));
    expect(choices[1]!.stream.audioTracks).toEqual([]);
    expect(audioStreamOptions([])).toEqual([]);
  });
  it('pins the actual catalog capability despite faster, missing, reordered, or reused-ID catalog entries', () => {
    const pinned = { ...stream('same-id', undefined, 1080), audioTracks: [], subtitles: [] };
    const replacement = { ...pinned, url: `${pinned.url}&snapshot=new`, startupLatencyMs: 0 };
    for (const candidates of [[], [replacement], [stream('fast', 1, 1080), replacement]]) {
      expect(chooseStream(candidates, DEFAULT_PREFERENCES, 'quality', undefined, pinned)).toBe(pinned);
      expect(streamPlaybackUrl(pinned, DEFAULT_PREFERENCES, 'https://example.test/api/vidnest?stream=auto')).toBe(pinned.url);
    }
    expect(chooseStream([replacement], { ...DEFAULT_PREFERENCES, audio: 'hi::' }, 'audio', undefined, pinned)).toBeUndefined();
    expect(chooseStream([replacement], { ...DEFAULT_PREFERENCES, quality: 'quality:2160' }, 'quality', undefined, pinned)).toBeUndefined();
    expect(chooseStream([replacement], DEFAULT_PREFERENCES, 'quality', undefined, null)).toBe(replacement);
  });
  it('never turns missing manual-quality metadata into an Auto/master request', () => {
    const fixed = { ...stream('pin', 10, 1080), qualities: [{ id: '9', label: '1080p', height: 1080 }] };
    const prefs = { ...DEFAULT_PREFERENCES, quality: 'quality:1080' };
    const url = new URL(streamPlaybackUrl(fixed, prefs, 'https://example.test/auto.m3u8')!);
    expect(url.searchParams.get('token')).toBe('pin');
    expect(url.searchParams.get('rendition')).toBe('9');
    expect(streamPlaybackUrl({ ...fixed, qualities: [] }, prefs, fixed.url)).toBeNull();
    expect(streamPlaybackUrl(null, prefs, fixed.url)).toBeNull();
    expect(streamPlaybackUrl({ ...fixed, url: 'https://example.test/unfiltered.m3u8' }, prefs, fixed.url)).toBeNull();
    expect(streamPlaybackUrl(fixed, DEFAULT_PREFERENCES, fixed.url)).toBe(fixed.url);
  });
});

describe('Android immutable VTT presentation and touch controls', () => {
  const vtt = 'WEBVTT\n\nlong\n00:00:00.000 --> 00:10:00.000\nLong cue\n\n00:00:10.000 --> 00:00:20.000 align:start\n<b>Short &amp; safe</b>\n\nNOTE ignored\nmetadata\n\n00:00:40.000 --> 00:00:50.000\nLater cue\n';
  it('keeps spanning overlapping cues after seeks and strips markup', () => {
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(3);
    expect(subtitleText(cues, 15, 0)).toBe('Long cue\nShort & safe');
    expect(subtitleText(cues, 500, 0)).toBe('Long cue');
  });
  it('positive delay and negative advance do not accumulate timing drift', () => {
    const cues = parseVtt('WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nHello\n');
    expect(subtitleText(cues, 10, 0.25)).toBe('');
    expect(subtitleText(cues, 10.25, 0.25)).toBe('Hello');
    expect(subtitleText(cues, 9.75, -0.25)).toBe('Hello');
    expect(subtitleText(cues, 10, 0)).toBe('Hello');
    expect(cues[0]).toEqual({ start: 10, end: 12, text: 'Hello' });
  });
  it('rejects non-VTT, invalid timestamps, reverse cues and oversized payloads', () => {
    expect(parseVtt('<html>error</html>')).toEqual([]);
    expect(parseVtt('WEBVTT\n\n00:99:00.000 --> 01:00:00.000\nBad\n')).toEqual([]);
    expect(parseVtt('WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nBad\n')).toEqual([]);
    expect(parseVtt(`WEBVTT\n\n${'x'.repeat(2 * 1024 * 1024)}`)).toEqual([]);
  });
  it('accepts only same-side, nearby touch double taps within 300ms', () => {
    const tap = { time: 100, x: 20, y: 30, side: 'left' as const };
    expect(doubleTap(tap, { ...tap, time: 400, x: 25 })).toBe(true);
    expect(doubleTap(tap, { ...tap, time: 401 })).toBe(false);
    expect(doubleTap(tap, { ...tap, time: 300, x: 80 })).toBe(false);
    expect(doubleTap(tap, { ...tap, time: 300, side: 'right' })).toBe(false);
  });
});

describe('Android scoped durable checkpoints', () => {
  let identity = 0;
  const nextKey = () => `movie:checkpoint-${++identity}`;
  beforeEach(() => { storage.values.clear(); storage.getItem.mockClear(); storage.setItem.mockClear(); });
  it('uses stable exact TV coordinates regardless of optional episode UUID, never unknown TV title-only', () => {
    const input = { titleId: 'show', type: 'tv' as const, season: 1, episode: 2 };
    expect(mediaKey(input)).toBe(mediaKey({ ...input, episodeId: 'uuid' }));
    expect(mediaKey({ titleId: 'show', type: 'tv' })).toBe('');
    expect(mediaKey({ ...input, episode: 3 })).not.toBe(mediaKey(input));
  });
  it('isolates guest, account, profile and episode; retains fractions and intentional zero', async () => {
    const key = nextKey();
    await writeCheckpoint('guest', key, 5.25, 100, true);
    await writeCheckpoint('account:a:profile:p', key, 22, 100, false);
    expect((await readCheckpoint('guest', key))?.positionSeconds).toBe(5.25);
    expect((await readCheckpoint('account:a:profile:p', key))?.positionSeconds).toBe(22);
    expect(await readCheckpoint('account:b:profile:p', key)).toBeNull();
    await writeCheckpoint('guest', key, 0, undefined, false);
    expect((await readCheckpoint('guest', key))?.positionSeconds).toBe(0);
  });
  it('unavailable scope and invalid checkpoints never persist', async () => {
    expect(await writeCheckpoint('unavailable', nextKey(), 1, undefined, true)).toBeNull();
    expect(await writeCheckpoint('guest', nextKey(), NaN, undefined, true)).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(validCheckpoint({ positionSeconds: 1, playing: true, updatedAt: Date.now() - 61 * 86400000 })).toBe(false);
  });
  it('serializes disk writes while immediately exposing the newest backward seek', async () => {
    const key = nextKey();
    let release!: () => void;
    storage.setItem.mockImplementationOnce(async (k, value) => { await new Promise<void>((resolve) => { release = resolve; }); storage.values.set(k, value); });
    const old = writeCheckpoint('guest', key, 60, 100, true);
    await Promise.resolve();
    const rewind = writeCheckpoint('guest', key, 0, 100, false);
    expect((await readCheckpoint('guest', key))?.positionSeconds).toBe(0);
    release();
    await Promise.all([old, rewind]);
    expect([...storage.values.values()].map((v) => JSON.parse(v).positionSeconds)).toEqual([0]);
  });
  it('pending account rewind beats a later old server write timestamp and only exact acknowledgement clears it', async () => {
    const key = nextKey();
    const old = (await writeCheckpoint('account:a', key, 60, 100, true, true))!;
    const rewind = (await writeCheckpoint('account:a', key, 0, 100, false, true))!;
    await markCheckpointSynced('account:a', key, old);
    let local = await readCheckpoint('account:a', key);
    const lateServer = { positionSeconds: 60, updatedAt: Date.now() + 1000 };
    expect(selectResume('account:a', local, lateServer)?.positionSeconds).toBe(0);
    await markCheckpointSynced('account:a', key, rewind);
    local = await readCheckpoint('account:a', key);
    expect(local?.pendingSync).toBe(false);
    expect(selectResume('account:a', local, lateServer)?.positionSeconds).toBe(60);
  });
});

describe('Android existing guest history preservation', () => {
  beforeEach(() => storage.values.clear());
  it('refreshing metadata does not erase the exact episode point', async () => {
    const entry = { slug: 'show', name: 'Show', type: 'tv' as const, seasonNumber: 1, episodeNumber: 1 };
    await recordGuestWatch(entry);
    await updateGuestPosition('show', 45.25, 100, { seasonNumber: 1, episodeNumber: 1 }, 'tv');
    await recordGuestWatch({ ...entry, posterUrl: 'poster.jpg' });
    expect((await getGuestResume('show', 'tv', 1, 1))?.positionSeconds).toBe(45.25);
    expect(await getGuestResume('show', 'tv', 1, 2)).toBeNull();
  });
  it('stores separate episodes and refuses unknown TV metadata and title-only updates', async () => {
    await recordGuestWatch({ slug: 'show', name: 'Show', type: 'tv', seasonNumber: 1, episodeNumber: 1, positionSeconds: 60 });
    await recordGuestWatch({ slug: 'show', name: 'Show', type: 'tv', seasonNumber: 1, episodeNumber: 2, positionSeconds: 5 });
    await recordGuestWatch({ slug: 'show', name: 'Show', type: 'tv' });
    await updateGuestPosition('show', 99, 100, undefined, 'tv');
    expect((await readGuestEntries()).map((e) => e.positionSeconds).sort()).toEqual([5, 60]);
  });
  it('serializes metadata and seek operations and preserves reset zero', async () => {
    await Promise.all([
      recordGuestWatch({ slug: 'film', name: 'Film', type: 'movie' }),
      updateGuestPosition('film', 25, 100, undefined, 'movie'),
      recordGuestWatch({ slug: 'film', name: 'Film', type: 'movie', backdropUrl: 'backdrop' }),
      updateGuestPosition('film', 0, 100, undefined, 'movie'),
    ]);
    expect((await getGuestResume('film', 'movie'))?.positionSeconds).toBe(0);
  });
});

describe('Android custom fullscreen rotation restoration', () => {
  it('restores the original platform lock even when the screen cleans up before fullscreen', async () => {
    const closePlayer = acquireOrientation(OrientationLock.DEFAULT);
    await vi.waitFor(() => expect(orientation.lockAsync).toHaveBeenLastCalledWith(OrientationLock.DEFAULT));
    const closeFullscreen = acquireOrientation(OrientationLock.LANDSCAPE);
    await vi.waitFor(() => expect(orientation.lockAsync).toHaveBeenLastCalledWith(OrientationLock.LANDSCAPE));
    closePlayer();
    closeFullscreen();
    await vi.waitFor(() => expect(orientation.lockPlatformAsync).toHaveBeenLastCalledWith({ screenOrientationConstantAndroid: 1 }));
  });
});
