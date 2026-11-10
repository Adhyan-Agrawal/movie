import { describe, expect, it } from 'vitest';
import { preferredLanguageTrack } from '@/features/player/track-preferences';

describe('offered native language matching', () => {
  it.each(['en', 'en-US', 'eng', 'ENG_us'])('matches reported language %s without using labels as evidence', (language) => {
    const offered = { language, label: 'Audio 1' };
    expect(preferredLanguageTrack([{ language: '', label: 'English' }, offered], 'en')).toBe(offered);
  });
  it('does not invent a track, label language, or numbered video stream', () => {
    expect(preferredLanguageTrack([{ label: 'English' }, { language: 'hi', label: 'Audio stream 1' }], 'en')).toBeUndefined();
    expect(preferredLanguageTrack([{ language: 'en' }], '')).toBeUndefined();
  });
  it('prefers a normal offered track over forced or commentary tracks', () => {
    const normal = { language: 'fr-FR', label: 'French' };
    expect(preferredLanguageTrack([{ language: 'fra', label: 'French commentary' }, normal], 'fr')).toBe(normal);
  });
  it('supports an explicitly reported alternate role when it is the only matching track', () => {
    const only = { language: 'deu', label: 'German SDH' };
    expect(preferredLanguageTrack([only], 'de')).toBe(only);
  });
});
