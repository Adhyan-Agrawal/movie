import { describe, expect, it } from 'vitest';
import { inferRemoteSourceKind, inferSourceKind, sanitizeUploadFilename } from '@/features/admin/source-utils';

/**
 * The source-utils helpers are pure and drive real DB writes (the `kind` column
 * is an enum — a bad inference fails the insert), so the mapping is pinned
 * here. No fabricated data: every case mirrors the documented mapping.
 */

describe('inferSourceKind', () => {
  it('maps HLS playlists (.m3u8 and .m3u) to hls', () => {
    expect(inferSourceKind('master.m3u8')).toBe('hls');
    expect(inferSourceKind('stream.m3u')).toBe('hls');
  });

  it('maps mp4 and m4v to mp4, case-insensitively', () => {
    expect(inferSourceKind('movie.mp4')).toBe('mp4');
    expect(inferSourceKind('movie.MP4')).toBe('mp4');
    expect(inferSourceKind('movie.Mp4')).toBe('mp4');
    expect(inferSourceKind('movie.m4v')).toBe('mp4');
  });

  it('maps DASH manifests (.mpd) to dash', () => {
    expect(inferSourceKind('manifest.mpd')).toBe('dash');
  });

  it('ignores query strings and fragments so stream URLs infer correctly', () => {
    expect(inferSourceKind('https://cdn.example.com/live/master.m3u8?token=abc&exp=1')).toBe('hls');
    expect(inferSourceKind('https://cdn.example.com/vod/episode.mp4#t=30')).toBe('mp4');
  });

  it('returns custom for unknown extensions', () => {
    expect(inferSourceKind('notes.txt')).toBe('custom');
    expect(inferSourceKind('video.webm')).toBe('custom');
  });

  it('returns custom when there is no usable extension', () => {
    expect(inferSourceKind('https://cdn.example.com/live/stream')).toBe('custom');
    expect(inferSourceKind('no-extension')).toBe('custom');
    expect(inferSourceKind('.hidden')).toBe('custom');
    expect(inferSourceKind('trailing.')).toBe('custom');
  });
});

describe('inferRemoteSourceKind', () => {
  it('uses the same extension inference when the URL has a known extension', () => {
    expect(inferRemoteSourceKind('https://cdn.example.com/master.m3u8')).toBe('hls');
    expect(inferRemoteSourceKind('https://cdn.example.com/vod.mp4')).toBe('mp4');
    expect(inferRemoteSourceKind('https://cdn.example.com/manifest.mpd')).toBe('dash');
  });

  it('defaults extension-less/unknown remote URLs to hls (most licensed streams are HLS)', () => {
    expect(inferRemoteSourceKind('https://cdn.example.com/live/stream')).toBe('hls');
    expect(inferRemoteSourceKind('https://cdn.example.com/file.txt')).toBe('hls');
  });
});

describe('sanitizeUploadFilename', () => {
  it('keeps a plain safe filename unchanged', () => {
    expect(sanitizeUploadFilename('episode-04.mp4')).toBe('episode-04.mp4');
    expect(sanitizeUploadFilename('Movie.1080p.mkv')).toBe('Movie.1080p.mkv');
  });

  it('strips path components from both separators (no directory traversal)', () => {
    expect(sanitizeUploadFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeUploadFilename('C:\\Users\\admin\\secret.mp4')).toBe('secret.mp4');
    expect(sanitizeUploadFilename('/var/tmp/video.mp4')).toBe('video.mp4');
  });

  it('replaces unsafe characters with single dashes and trims edge separators', () => {
    expect(sanitizeUploadFilename('my video: final!! cut.mp4')).toBe('my-video-final-cut.mp4');
    expect(sanitizeUploadFilename('..name..')).toBe('name');
    expect(sanitizeUploadFilename('--name--')).toBe('name');
  });

  it('caps length at 120 characters', () => {
    expect(sanitizeUploadFilename(`${'a'.repeat(300)}.mp4`).length).toBe(120);
  });

  it('returns an empty string when nothing usable remains', () => {
    expect(sanitizeUploadFilename('///')).toBe('');
    expect(sanitizeUploadFilename('???')).toBe('');
    expect(sanitizeUploadFilename('')).toBe('');
  });
});
