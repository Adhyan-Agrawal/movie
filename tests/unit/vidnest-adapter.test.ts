import { describe, expect, it } from 'vitest';
import { createVidnestAdapter } from '@/lib/providers/vidnest';
import { VIDNEST_PROVIDER_CONFIG } from '@/lib/providers/config';
import { ProviderError } from '@/lib/providers/types';

describe('VidNest unified direct source', () => {
  it('returns one Direct HLS source with automatic healthy startup and a separate catalog', async () => {
    const sources = await createVidnestAdapter(VIDNEST_PROVIDER_CONFIG).resolve({ titleId: 'movie', tmdbId: '27205', type: 'movie' });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ label: 'Direct', kind: 'hls', providerId: 'vidnest' });
    expect(sources[0]!.url).toBe('/api/vidnest?tmdbId=27205&type=movie&stream=auto');
    expect(sources[0]!.streamCatalogUrl).toBe('/api/vidnest?tmdbId=27205&type=movie&metadata=1');
  });

  it('includes the selected TV episode in both endpoints', async () => {
    const [source] = await createVidnestAdapter(VIDNEST_PROVIDER_CONFIG).resolve({ titleId: 'tv', tmdbId: '1399', type: 'tv', season: 2, episode: 5 });
    for (const endpoint of [source!.url, source!.streamCatalogUrl]) {
      const params = new URL(endpoint!, 'https://app.example').searchParams;
      expect(params.get('season')).toBe('2');
      expect(params.get('episode')).toBe('5');
    }
  });

  it('preserves disabled and invalid request handling', async () => {
    const adapter = createVidnestAdapter({ ...VIDNEST_PROVIDER_CONFIG, enabled: false });
    await expect(adapter.resolve({ titleId: 'movie', type: 'movie' })).resolves.toEqual([]);
    await expect(createVidnestAdapter(VIDNEST_PROVIDER_CONFIG).resolve({ titleId: 'movie', type: 'movie' })).rejects.toBeInstanceOf(ProviderError);
    await expect(createVidnestAdapter(VIDNEST_PROVIDER_CONFIG).resolve({ titleId: 'tv', type: 'tv', tmdbId: '1399' })).rejects.toBeInstanceOf(ProviderError);
  });
});
