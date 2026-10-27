import type { DirectAudioTrack, DirectStream, Quality, Track } from '@/lib/providers/types';

export interface StreamPreferences {
  quality: string;
  audio: string;
  subtitle: string;
}

export interface StreamOption {
  id: string;
  label: string;
  language?: string;
  height?: number;
}

const RESOLUTIONS = [240, 360, 480, 540, 720, 1080, 1440, 2160, 4320];
const LANGUAGE_ALIASES: Record<string, string> = {
  eng: 'en', hin: 'hi', tam: 'ta', tel: 'te', mal: 'ml', ben: 'bn',
  fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es', jpn: 'ja',
  kor: 'ko', zho: 'zh', chi: 'zh', por: 'pt', rus: 'ru', ara: 'ar', ita: 'it',
};

export function nominalQualityHeight(quality: Quality & { width?: number }): number | undefined {
  const letterboxed = Boolean(quality.width && quality.height && quality.width / quality.height > 16 / 9 * 1.02);
  const height = letterboxed && quality.width ? quality.width * 9 / 16 : quality.height;
  if (height && Number.isFinite(height) && height > 0) {
    return letterboxed
      ? RESOLUTIONS.find((resolution) => Math.abs(resolution - height) / resolution < 0.08) ?? Math.round(height)
      : Math.round(height);
  }
  if (/\b(?:4k|uhd)\b/i.test(quality.label)) return 2160;
  const labeled = /\b(\d{3,4})p\b/i.exec(quality.label);
  return labeled ? Number(labeled[1]) : undefined;
}

export function qualityKey(quality: Quality & { width?: number }): string {
  const height = nominalQualityHeight(quality);
  return height ? `quality:${height}` : `bitrate:${quality.bitrateKbps ?? quality.label.toLowerCase()}`;
}

export function trackKey(track: { language?: string; label?: string }): string {
  const language = (track.language ?? '').trim().toLowerCase().replace(/_/g, '-');
  const label = (track.label ?? '').trim().toLowerCase();
  const normalizedLanguage = LANGUAGE_ALIASES[language] ?? language;
  const role = /commentary|descript(?:ion|ive)|\bsdh\b|\bforced\b/.exec(label)?.[0] ?? '';
  const channels = /\b(?:[57]\.1|stereo|surround)\b/.exec(label)?.[0] ?? '';
  return `${normalizedLanguage || label || 'und'}:${role}:${channels}`;
}

export function aggregateStreamOptions(streams: DirectStream[]): {
  qualities: StreamOption[];
  audioTracks: StreamOption[];
  subtitles: StreamOption[];
} {
  const qualities = new Map<string, StreamOption>();
  const audioTracks = new Map<string, StreamOption>();
  const subtitles = new Map<string, StreamOption>();
  for (const stream of streams) {
    for (const quality of stream.qualities) {
      if (quality.auto) continue;
      const id = qualityKey(quality);
      const height = nominalQualityHeight(quality);
      if (!qualities.has(id)) qualities.set(id, {
        id, height,
        label: height === 2160 ? '4K' : height === 4320 ? '8K' : height ? `${height}p` : quality.label,
      });
    }
    for (const track of stream.audioTracks) {
      const id = trackKey(track);
      if (!audioTracks.has(id)) audioTracks.set(id, { id, label: track.label || track.language || 'Default audio', language: track.language });
    }
    for (const track of stream.subtitles) {
      const id = trackKey(track);
      if (!subtitles.has(id)) subtitles.set(id, { id, label: track.label || track.language || 'Subtitles', language: track.language });
    }
  }
  return {
    qualities: [...qualities.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0)),
    audioTracks: [...audioTracks.values()],
    subtitles: [...subtitles.values()],
  };
}

export function findQualityForStream(stream: DirectStream, id: string): Quality | undefined {
  return stream.qualities.find((quality) => qualityKey(quality) === id);
}

export function findAudioForStream(stream: DirectStream, id: string): DirectAudioTrack | undefined {
  return stream.audioTracks.find((track) => trackKey(track) === id);
}

export function findSubtitleForStream(stream: DirectStream, id: string): Track | undefined {
  return stream.subtitles.find((track) => trackKey(track) === id);
}

export function chooseStream(
  streams: DirectStream[],
  preferences: StreamPreferences,
  changed: keyof StreamPreferences,
  currentStreamId?: string,
): DirectStream | undefined {
  const matches = (stream: DirectStream, field: keyof StreamPreferences) => {
    const id = preferences[field];
    if (!id || (field === 'quality' && id === 'auto') || (field === 'subtitle' && id === 'off')) return true;
    return field === 'quality' ? Boolean(findQualityForStream(stream, id))
      : field === 'audio' ? Boolean(findAudioForStream(stream, id))
      : Boolean(findSubtitleForStream(stream, id));
  };
  const candidates = streams.filter((stream) => matches(stream, changed));
  const score = (stream: DirectStream) => {
    return (preferences.audio && matches(stream, 'audio') ? 1000 : 0)
      + (preferences.subtitle !== 'off' && matches(stream, 'subtitle') ? 500 : 0)
      + (preferences.quality !== 'auto' && matches(stream, 'quality') ? 100 : 0);
  };
  const latency = (stream: DirectStream) => typeof stream.startupLatencyMs === 'number'
    && Number.isFinite(stream.startupLatencyMs) && stream.startupLatencyMs >= 0 ? stream.startupLatencyMs : Infinity;
  return candidates.sort((a, b) => score(b) - score(a)
    || latency(a) - latency(b)
    || Number(b.id === currentStreamId) - Number(a.id === currentStreamId))[0];
}

export function preferencesForStream(stream: DirectStream, preferences: StreamPreferences): StreamPreferences {
  const defaultAudio = stream.audioTracks.find((track) => track.default) ?? stream.audioTracks[0];
  return {
    quality: preferences.quality === 'auto' || findQualityForStream(stream, preferences.quality) ? preferences.quality : 'auto',
    audio: findAudioForStream(stream, preferences.audio) ? preferences.audio : defaultAudio ? trackKey(defaultAudio) : '',
    subtitle: preferences.subtitle !== 'off' && findSubtitleForStream(stream, preferences.subtitle) ? preferences.subtitle : 'off',
  };
}
