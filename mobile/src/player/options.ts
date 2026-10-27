import type { DirectStream, MediaTrack, Quality } from '../lib/types';

export interface Preferences { quality: string; audio: string; subtitle: string }
export const DEFAULT_PREFERENCES: Preferences = { quality: 'auto', audio: '', subtitle: 'off' };
const ALIASES: Record<string, string> = {
  eng: 'en', hin: 'hi', tam: 'ta', tel: 'te', mal: 'ml', ben: 'bn', fra: 'fr', fre: 'fr',
  deu: 'de', ger: 'de', spa: 'es', jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', por: 'pt',
  rus: 'ru', ara: 'ar', ita: 'it',
};

export function trackKey(track: Pick<MediaTrack, 'label' | 'language'>): string {
  const language = track.language.trim().toLowerCase().replace(/_/g, '-');
  const label = track.label.trim().toLowerCase();
  const role = /commentary|descript(?:ion|ive)|\bsdh\b|\bforced\b/.exec(label)?.[0] ?? '';
  const channels = /\b(?:[57]\.1|stereo|surround)\b/.exec(label)?.[0] ?? '';
  return `${(ALIASES[language] ?? language) || label || 'und'}:${role}:${channels}`;
}

export function qualityHeight(quality: Quality): number | undefined {
  const letterbox = !!(quality.width && quality.height && quality.width / quality.height > 16 / 9 * 1.02);
  const height = letterbox ? quality.width! * 9 / 16 : quality.height;
  if (height && Number.isFinite(height) && height > 0) {
    return letterbox
      ? [240, 360, 480, 540, 720, 1080, 1440, 2160, 4320].find((h) => Math.abs(h - height) / h < 0.08) ?? Math.round(height)
      : Math.round(height);
  }
  if (/\b(?:4k|uhd)\b/i.test(quality.label)) return 2160;
  const match = /\b(\d{3,4})p\b/i.exec(quality.label);
  return match ? Number(match[1]) : undefined;
}

export function qualityKey(quality: Quality): string {
  const height = qualityHeight(quality);
  return height ? `quality:${height}` : `bitrate:${quality.bitrateKbps ?? quality.label.toLowerCase()}`;
}

export function supports(stream: DirectStream, preferences: Preferences, field: keyof Preferences): boolean {
  const id = preferences[field];
  if (!id || (field === 'quality' && id === 'auto') || (field === 'subtitle' && (id === 'off' || id.startsWith('sidecar:')))) return true;
  return field === 'quality' ? stream.qualities.some((q) => qualityKey(q) === id)
    : (field === 'audio' ? stream.audioTracks : stream.subtitles).some((t) => trackKey(t) === id);
}

/** Measured latency wins at every resolution; explicit changes retain compatible preferences. */
export function chooseStream(streams: DirectStream[], preferences: Preferences, changed: keyof Preferences, currentId?: string): DirectStream | undefined {
  const score = (s: DirectStream) => (preferences.audio && supports(s, preferences, 'audio') ? 1000 : 0)
    + (preferences.subtitle !== 'off' && supports(s, preferences, 'subtitle') ? 500 : 0)
    + (preferences.quality !== 'auto' && supports(s, preferences, 'quality') ? 100 : 0);
  const latency = (s: DirectStream) => Number.isFinite(s.startupLatencyMs) && s.startupLatencyMs! >= 0 ? s.startupLatencyMs! : Infinity;
  return streams.filter((s) => supports(s, preferences, changed)).sort((a, b) => score(b) - score(a)
    || latency(a) - latency(b) || Number(b.id === currentId) - Number(a.id === currentId))[0];
}

export function compatiblePreferences(stream: DirectStream, preferences: Preferences): Preferences {
  const audio = stream.audioTracks.find((t) => t.default) ?? stream.audioTracks[0];
  return {
    quality: supports(stream, preferences, 'quality') ? preferences.quality : 'auto',
    audio: supports(stream, preferences, 'audio') ? preferences.audio : audio ? trackKey(audio) : '',
    subtitle: supports(stream, preferences, 'subtitle') ? preferences.subtitle : 'off',
  };
}

export function renditionUrl(url: string, quality?: Quality): string {
  const parsed = new URL(url);
  // The bridge is the sole authority for upstream capabilities. Never use native track URLs.
  if (parsed.pathname !== '/api/vidnest') return url;
  if (!quality || quality.auto) {
    if (!parsed.searchParams.has('rendition')) return url;
    parsed.searchParams.delete('rendition');
  } else parsed.searchParams.set('rendition', quality.id);
  return parsed.href;
}
