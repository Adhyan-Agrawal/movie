import { trackKey } from './stream-options';

/** Match only reported language tags, never guessed labels or numbered streams. */
export function preferredLanguageTrack<T extends { language?: string; label?: string }>(tracks: readonly T[], language: string): T | undefined {
  const normalized = (value: string) => trackKey({ language: value.trim().toLowerCase().replace(/_/g, '-').split('-')[0] });
  if (!language.trim()) return undefined;
  const matches = tracks.filter((track) => track.language && normalized(track.language) === normalized(language));
  return matches.find((track) => !/commentary|descript(?:ion|ive)|\bforced\b/i.test(track.label ?? '')) ?? matches[0];
}
