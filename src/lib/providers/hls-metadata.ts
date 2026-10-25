import type { DirectAudioTrack, DirectStream, Quality, Track } from './types';

export type HlsMetadata = Pick<DirectStream, 'qualities' | 'audioTracks' | 'subtitles'>;

/** Labels are untrusted gateway/manifest data, not URLs or diagnostics. */
export function metadataLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  const label = value.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return label.length <= 80 && !/(?:https?:|\/\/|[?&](?:token|key|secret)=)/i.test(label) ? label : '';
}

export function metadataLanguage(value: unknown): string {
  const language = metadataLabel(value);
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language) ? language : '';
}

export function decodedAudioTracks(languages: string[]): DirectAudioTrack[] {
  return languages.map((language, index) => {
    let label = language === 'eng' ? 'English' : language === 'hin' ? 'Hindi' : language.toUpperCase();
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(language);
      if (name && name !== language) label = metadataLabel(name) || label;
    } catch { /* Minimal server ICU builds can fall back to the decoded ISO-639 code. */ }
    return { id: `decoded:${language}:${index}`, language, label, ...(index === 0 ? { default: true } : {}) };
  });
}

/** fMP4 languages belong to audio trak/mdia/mdhd boxes in the bounded initialization segment. */
export function parseMp4AudioLanguages(input: Uint8Array): { complete: boolean; audioLanguages: string[] } {
  const bytes = input.subarray(0, 64 * 1024);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  type Box = { type: string; start: number; end: number };
  const boxAt = (offset: number, end: number): Box | undefined => {
    if (offset + 8 > end) return undefined;
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end || view.getUint32(offset + 8)) return undefined;
      size = view.getUint32(offset + 12); header = 16;
    }
    if (size < header || offset + size > end) return undefined;
    return { type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), start: offset + header, end: offset + size };
  };
  const children = (parent: Box): Box[] | undefined => {
    const result: Box[] = [];
    for (let offset = parent.start; offset < parent.end;) {
      const box = boxAt(offset, parent.end);
      if (!box) return undefined;
      result.push(box); offset = box.end;
    }
    return result;
  };
  for (let offset = 0; offset < bytes.length;) {
    const box = boxAt(offset, bytes.length);
    if (!box) break;
    offset = box.end;
    if (box.type !== 'moov') continue;
    const tracks = children(box);
    if (!tracks) break;
    const audioLanguages: string[] = [];
    for (const track of tracks.filter((candidate) => candidate.type === 'trak')) {
      const trackBoxes = children(track);
      const mdia = trackBoxes?.find((candidate) => candidate.type === 'mdia');
      if (!mdia) continue;
      const media = children(mdia);
      const handler = media?.find((candidate) => candidate.type === 'hdlr');
      const header = media?.find((candidate) => candidate.type === 'mdhd');
      if (!handler || handler.start + 12 > handler.end || !header
        || String.fromCharCode(...bytes.subarray(handler.start + 8, handler.start + 12)) !== 'soun') continue;
      const version = bytes[header.start];
      const position = header.start + (version === 0 ? 20 : 32);
      if ((version !== 0 && version !== 1) || position + 4 > header.end) continue;
      const packed = view.getUint16(position);
      // QuickTime's legacy mdhd language code 0 explicitly means English, not ISO-639 "und".
      if (packed === 0) { audioLanguages.push('eng'); continue; }
      const codes = [(packed >> 10) & 31, (packed >> 5) & 31, packed & 31];
      if ((packed & 0x8000) || codes.some((code) => code < 1 || code > 26)) continue;
      const language = metadataLanguage(String.fromCharCode(...codes.map((code) => code + 96))).toLowerCase();
      if (language && !['und', 'mul', 'zxx'].includes(language)) audioLanguages.push(language);
    }
    return { complete: true, audioLanguages };
  }
  return { complete: false, audioLanguages: [] };
}

export function httpsUrl(value: unknown, base?: string): string | undefined {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of value.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/gi)) {
    result[match[1]!.toUpperCase()] = match[2] ?? match[3] ?? '';
  }
  return result;
}

type StartupResource = { url: string; offset: number; length?: number };
export type HlsStartupPlan = { variantUrl?: string; media?: StartupResource; init?: StartupResource };

/** Validate playback references independently of benchmark codec/encryption support. */
export function hasHlsPlaybackUri(playlist: string, sourceUrl: string, isSafe: (url: string) => boolean): boolean {
  const lines = playlist.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== '#EXTM3U') return false;
  let expectedUri = false;
  let playbackUri = false;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line.startsWith('#')) {
      const uri = attributes(line.slice(line.indexOf(':') + 1)).URI;
      if (uri !== undefined) {
        const url = httpsUrl(uri, sourceUrl);
        if (!url || !isSafe(url)) return false;
        if (line.startsWith('#EXT-X-PART:')) playbackUri = true;
      }
      if (line.startsWith('#EXT-X-STREAM-INF:') || line.startsWith('#EXTINF:')) expectedUri = true;
    } else {
      const url = httpsUrl(line, sourceUrl);
      if (!url || !isSafe(url)) return false;
      if (expectedUri) playbackUri = true;
      expectedUri = false;
    }
  }
  return playbackUri;
}

/** Server-only startup references. Never fetch encryption keys or whole media. */
export function hlsStartupPlan(playlist: string, sourceUrl: string): HlsStartupPlan | undefined {
  const lines = playlist.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== '#EXTM3U') return undefined;
  if (lines.some((line) => /^(?:#EXT-X-KEY|#EXT-X-SESSION-KEY):/.test(line)
    && attributes(line.slice(line.indexOf(':') + 1)).METHOD !== 'NONE')) return undefined;
  const variants: Array<{ url: string; height: number; bandwidth: number; compatible: boolean }> = [];
  let variant: Record<string, string> | undefined;
  let init: StartupResource | undefined;
  let mediaExpected = false;
  let byteRange: string | undefined;
  const resource = (value: string, range?: string): StartupResource | undefined => {
    const url = httpsUrl(value, sourceUrl);
    if (!url) return undefined;
    if (!range) return { url, offset: 0 };
    const match = /^(\d+)@(\d+)$/.exec(range);
    if (!match) return undefined; // An implicit offset cannot identify the first segment safely.
    const length = Number(match[1]);
    const offset = Number(match[2]);
    return Number.isSafeInteger(length) && length > 0 && Number.isSafeInteger(offset) && offset >= 0
      && Number.isSafeInteger(offset + length) ? { url, length, offset } : undefined;
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) variant = attributes(line.slice(18));
    else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = attributes(line.slice(11));
      init = resource(attrs.URI ?? '', attrs.BYTERANGE);
      if (!init) return undefined;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) byteRange = line.slice(17);
    else if (line.startsWith('#EXTINF:')) mediaExpected = true;
    else if (line && !line.startsWith('#')) {
      if (variant) {
        const url = httpsUrl(line, sourceUrl);
        if (url) variants.push({
          url, height: Number(variant.RESOLUTION?.split('x')[1]) || 0,
          bandwidth: Number(variant.BANDWIDTH) || Number.MAX_SAFE_INTEGER,
          compatible: !variant.CODECS || /(?:^|,)\s*avc1/i.test(variant.CODECS),
        });
        variant = undefined;
      } else if (mediaExpected) {
        const media = resource(line, byteRange);
        return media ? { media, ...(init ? { init } : {}) } : undefined;
      }
    }
  }
  const compatible = variants.filter((candidate) => candidate.compatible);
  const low = compatible.filter((candidate) => !candidate.height || candidate.height <= 720);
  const selected = (low.length ? low : compatible).sort((a, b) => a.bandwidth - b.bandwidth)[0];
  return selected ? { variantUrl: selected.url } : undefined;
}

export function parseHlsMetadata(playlist: string): HlsMetadata {
  const qualities: Quality[] = [];
  const audioTracks: DirectAudioTrack[] = [];
  const subtitles: Track[] = [];
  const lines = playlist.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/);
  if (lines[0]?.trim() !== '#EXTM3U') return { qualities, audioTracks, subtitles };

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = attributes(line.slice('#EXT-X-STREAM-INF:'.length));
      let uri: string | undefined;
      for (let next = index + 1; next < lines.length; next++) {
        const candidate = lines[next]!.trim();
        if (candidate.startsWith('#EXT-X-STREAM-INF:')) break;
        if (candidate && !candidate.startsWith('#')) { uri = candidate; break; }
      }
      if (!uri) continue;
      const resolution = /^(\d+)x(\d+)$/i.exec(attrs.RESOLUTION ?? '');
      const rawWidth = resolution ? Number(resolution[1]) : 0;
      const rawHeight = resolution ? Number(resolution[2]) : 0;
      const validResolution = Number.isSafeInteger(rawWidth) && Number.isSafeInteger(rawHeight) && rawWidth > 0 && rawHeight > 0;
      const width = validResolution ? rawWidth : undefined;
      const height = validResolution ? rawHeight : undefined;
      const bandwidth = Number(attrs['AVERAGE-BANDWIDTH'] || attrs.BANDWIDTH);
      const bitrateKbps = Number.isFinite(bandwidth) && bandwidth > 0 ? Math.round(bandwidth / 1000) : undefined;
      qualities.push({
        id: String(qualities.length),
        label: height ? `${height}p` : bitrateKbps ? `${bitrateKbps} kbps` : 'Variant',
        ...(width && height ? { width, height } : {}),
        ...(bitrateKbps ? { bitrateKbps } : {}),
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = attributes(line.slice('#EXT-X-MEDIA:'.length));
      const language = metadataLanguage(attrs.LANGUAGE);
      const label = metadataLabel(attrs.NAME) || language;
      if (attrs.TYPE === 'AUDIO') {
        audioTracks.push({
          id: String(audioTracks.length), label: label || `Audio ${audioTracks.length + 1}`, language,
          ...(attrs.DEFAULT === 'YES' ? { default: true } : {}),
        });
      } else if (attrs.TYPE === 'SUBTITLES' || attrs.TYPE === 'CLOSED-CAPTIONS') {
        subtitles.push({
          id: String(subtitles.length), label: label || `Subtitles ${subtitles.length + 1}`, language,
          kind: attrs.TYPE === 'CLOSED-CAPTIONS' ? 'captions' : 'subtitles',
          ...(attrs.DEFAULT === 'YES' ? { default: true } : {}),
          // Rendition URIs are HLS playlists, not addRemoteTextTrack WebVTT files.
        });
      }
    }
  }
  return { qualities, audioTracks, subtitles };
}
