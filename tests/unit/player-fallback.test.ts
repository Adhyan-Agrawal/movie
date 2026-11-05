import { describe, expect, it } from 'vitest';
import type { PlaybackSource } from '@/lib/providers/types';
import { selectPlaybackFallback } from '@/features/player/source-fallback';

const sources: PlaybackSource[] = [
  { id: 'direct', providerId: 'direct', label: 'Direct', kind: 'hls', url: '/api/direct', consentRequired: true, capabilities: {} as PlaybackSource['capabilities'] },
  { id: 'embed-1', providerId: 'embed', label: 'Server 1', kind: 'embed', url: 'https://embed.example/1', consentRequired: true, capabilities: {} as PlaybackSource['capabilities'] },
  { id: 'embed-2', providerId: 'embed', label: 'Server 2', kind: 'iframe', url: 'https://embed.example/2', consentRequired: true, capabilities: {} as PlaybackSource['capabilities'] },
];

describe('playback source fallback', () => {
  it('prefers an unfailed embed after native playback fails', () => {
    expect(selectPlaybackFallback(sources, 'direct', new Set(['direct']))?.id).toBe('embed-1');
  });

  it('advances past failed embeds and stops when every source failed', () => {
    expect(selectPlaybackFallback(sources, 'embed-1', new Set(['direct', 'embed-1']))?.id).toBe('embed-2');
    expect(selectPlaybackFallback(sources, 'embed-2', new Set(sources.map((source) => source.id)))).toBeNull();
  });
});
