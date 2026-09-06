import { describe, expect, it } from 'vitest';
import { buildVidsrcUrl, createVidsrcAdapter } from '@/lib/providers/vidsrc';
import { VIDSRC_PROVIDER_CONFIG, type ProviderConfig } from '@/lib/providers/config';
import { ProviderError, type PlaybackRequest } from '@/lib/providers/types';
import { resolvePlayback } from '@/lib/providers/registry';

/**
 * Contract tests for the Vidsrc/VSEmbed adapter (Spec Section 9). Covers movie
 * (TMDB + IMDb), whole-series, specific episode, shorthand episode, invalid /
 * ambiguous id, disabled provider, and host-allowlist rejection.
 */

const CONFIG = VIDSRC_PROVIDER_CONFIG;

function withConfig(overrides: Partial<ProviderConfig>): ProviderConfig {
  return { ...CONFIG, ...overrides };
}

/** Run `fn`, assert it threw a ProviderError, and return it for inspection. */
function catchProviderError(fn: () => unknown): ProviderError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('expected a ProviderError to be thrown');
}

const movieTmdb: PlaybackRequest = { titleId: 't-a', type: 'movie', tmdbId: '27205' };
const movieImdb: PlaybackRequest = { titleId: 't-b', type: 'movie', imdbId: 'tt0468569' };

describe('buildVidsrcUrl', () => {
  it('resolves a movie by numeric TMDB id', () => {
    const url = new URL(buildVidsrcUrl(CONFIG, movieTmdb));
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('vsembed.su');
    expect(url.pathname).toBe('/embed/movie/27205');
    expect(url.search).toBe(''); // no query strings / tokens
  });

  it('resolves a movie by IMDb tt id', () => {
    const url = new URL(buildVidsrcUrl(CONFIG, movieImdb));
    expect(url.pathname).toBe('/embed/movie/tt0468569');
  });

  it('prefers IMDb id over TMDB id when both are present', () => {
    const url = new URL(
      buildVidsrcUrl(CONFIG, { titleId: 't', type: 'movie', imdbId: 'tt0468569', tmdbId: '27205' }),
    );
    expect(url.pathname).toBe('/embed/movie/tt0468569');
  });

  it('resolves a whole TV series (built-in picker) when no season/episode', () => {
    const url = new URL(buildVidsrcUrl(CONFIG, { titleId: 't', type: 'tv', tmdbId: '1399' }));
    expect(url.pathname).toBe('/embed/tv/1399');
  });

  it('resolves a specific season and episode', () => {
    const url = new URL(
      buildVidsrcUrl(CONFIG, { titleId: 't', type: 'tv', tmdbId: '1399', season: 2, episode: 5 }),
    );
    expect(url.pathname).toBe('/embed/tv/1399/2/5');
  });

  it('resolves the shorthand season-episode route', () => {
    const url = new URL(
      buildVidsrcUrl(CONFIG, { titleId: 't', type: 'tv', tmdbId: '1399', season: 2, episode: 5 }, { shorthand: true }),
    );
    expect(url.pathname).toBe('/embed/tv/1399-2-5');
  });

  it('throws a recoverable error when no identifier is available (ambiguous)', () => {
    const err = catchProviderError(() => buildVidsrcUrl(CONFIG, { titleId: 't', type: 'movie' }));
    expect(err.code).toBe('invalid-request');
    expect(err.recoverable).toBe(true);
  });

  it('throws a recoverable error for a malformed TMDB id', () => {
    const err = catchProviderError(() =>
      buildVidsrcUrl(CONFIG, { titleId: 't', type: 'movie', tmdbId: '12ab' }),
    );
    expect(err.code).toBe('invalid-request');
    expect(err.recoverable).toBe(true);
  });

  it('throws a recoverable error for a malformed IMDb id', () => {
    const err = catchProviderError(() =>
      buildVidsrcUrl(CONFIG, { titleId: 't', type: 'movie', imdbId: 'tt12' }),
    );
    expect(err.code).toBe('invalid-request');
  });

  it('throws when a specific episode is missing its season', () => {
    const err = catchProviderError(() =>
      buildVidsrcUrl(CONFIG, { titleId: 't', type: 'tv', tmdbId: '1399', episode: 5 }),
    );
    expect(err.code).toBe('invalid-request');
    expect(err.recoverable).toBe(true);
  });

  it('throws provider-disabled for a disabled provider', () => {
    const err = catchProviderError(() => buildVidsrcUrl(withConfig({ enabled: false }), movieTmdb));
    expect(err.code).toBe('provider-disabled');
    expect(err.recoverable).toBe(true);
  });

  it('rejects a host that is not in the allowlist (never returns an unsafe URL)', () => {
    const err = catchProviderError(() =>
      buildVidsrcUrl(withConfig({ allowedDomains: ['example.com'] }), movieTmdb),
    );
    expect(err.code).toBe('host-not-allowed');
    expect(err.recoverable).toBe(true);
  });

  it('rejects a template that escapes to a foreign host', () => {
    const err = catchProviderError(() =>
      buildVidsrcUrl(withConfig({ moviePathTemplate: '//evil.example/{id}' }), movieTmdb),
    );
    expect(err.code).toBe('host-not-allowed');
  });

  it('allows a subdomain of an allowed domain', () => {
    const url = new URL(
      buildVidsrcUrl(withConfig({ baseUrl: 'https://cdn.vsembed.su' }), movieTmdb),
    );
    expect(url.hostname).toBe('cdn.vsembed.su');
    expect(url.pathname).toBe('/embed/movie/27205');
  });
});

describe('vidsrc adapter', () => {
  it('resolve() returns a sanitized embed source with honest capabilities', async () => {
    const adapter = createVidsrcAdapter(CONFIG);
    const sources = await adapter.resolve(movieTmdb);
    expect(sources).toHaveLength(1);

    const source = sources[0]!;
    expect(source.kind).toBe('embed');
    expect(source.external).toBe(true);
    expect(source.providerId).toBe('vidsrc');
    expect(source.consentRequired).toBe(true);
    expect(new URL(source.url as string).pathname).toBe('/embed/movie/27205');
    // Embed providers expose no reliable telemetry — we must not claim it.
    expect(source.capabilities.telemetry).toBe(false);
    expect(source.capabilities.fullscreen).toBe(true);
  });

  it('resolve() marks episodeSelection only for TV', async () => {
    const adapter = createVidsrcAdapter(CONFIG);
    const [movie] = await adapter.resolve(movieTmdb);
    const [tv] = await adapter.resolve({ titleId: 't', type: 'tv', tmdbId: '1399' });
    expect(movie!.capabilities.episodeSelection).toBe(false);
    expect(tv!.capabilities.episodeSelection).toBe(true);
  });

  it('resolve() returns no source when the provider is disabled', async () => {
    const adapter = createVidsrcAdapter(withConfig({ enabled: false }));
    await expect(adapter.resolve(movieTmdb)).resolves.toEqual([]);
  });

  it('resolve() rejects with a ProviderError for an invalid request', async () => {
    const adapter = createVidsrcAdapter(CONFIG);
    await expect(adapter.resolve({ titleId: 't', type: 'movie' })).rejects.toBeInstanceOf(ProviderError);
  });

  it('healthCheck() reports disabled without any network call', async () => {
    const adapter = createVidsrcAdapter(withConfig({ enabled: false }));
    const health = await adapter.healthCheck();
    expect(health.status).toBe('disabled');
    expect(health.providerId).toBe('vidsrc');
    expect(typeof health.checkedAt).toBe('string');
  });

  it('normalizeError() maps a ProviderError through unchanged', () => {
    const adapter = createVidsrcAdapter(CONFIG);
    const normalized = adapter.normalizeError(
      new ProviderError({ code: 'invalid-request', message: 'bad', recoverable: true, providerId: 'vidsrc' }),
    );
    expect(normalized.code).toBe('invalid-request');
    expect(normalized.recoverable).toBe(true);
  });

  it('normalizeError() maps network + unknown errors to safe codes without leaking detail', () => {
    const adapter = createVidsrcAdapter(CONFIG);
    expect(adapter.normalizeError(new TypeError('fetch failed')).code).toBe('network');

    const generic = adapter.normalizeError(new Error('boom http://secret.example/token?x=1'));
    expect(generic.code).toBe('provider-error');
    expect(generic.recoverable).toBe(true);
    expect(generic.message).not.toContain('secret.example');
  });
});

describe('registry.resolvePlayback', () => {
  it('returns one source per enabled provider, best (highest priority) first', async () => {
    const resolved = await resolvePlayback(movieTmdb);
    expect(resolved.source).not.toBeNull();
    // All four configured providers resolve the same request; the highest
    // priority provider (vidup, Server 1) wins.
    expect(resolved.providerId).toBe('vidup');
    expect(resolved.sources).toHaveLength(4);
    expect(resolved.sources.map((s) => s.providerId)).toEqual([
      'vidup',
      '2embed',
      'vidsrc',
      'vidsrc-mov',
    ]);
    expect(resolved.error).toBeNull();
    expect(resolved.attempted).toContain('vidsrc');
  });

  it('returns a normalized error (no source) for an invalid request', async () => {
    const resolved = await resolvePlayback({ titleId: 't', type: 'movie' });
    expect(resolved.source).toBeNull();
    expect(resolved.providerId).toBeNull();
    expect(resolved.error?.code).toBe('invalid-request');
    expect(resolved.attempted).toContain('vidsrc');
  });
});
