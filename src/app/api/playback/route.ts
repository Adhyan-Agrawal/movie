import { NextRequest, NextResponse } from 'next/server';
import { getPlaybackCommerceContext } from '@/features/commerce/queries';
import { features } from '@/lib/env';
import { getActiveProviderConfigs, resolvePlayback } from '@/lib/providers/registry';
import type { PlaybackRequest, PlaybackSource } from '@/lib/providers/types';
import { introCatalogPath } from '@/features/player/intro-markers';
import { episodeNavigationPath } from '@/features/player/episode-navigation';

/**
 * Playback bridge for the native app (Spec Section 9).
 *
 * The provider registry, URL templates, host allowlist and anonymization all
 * live server-side in the web app. Rather than duplicating that logic in React
 * Native, the native client asks this endpoint for the sanitized sources it
 * should offer:
 *
 *   GET /api/playback?type=tv&tmdbId=1396&season=1&episode=1
 *
 * The response is EXACTLY what the web player receives — sources relabelled
 * "Server 1..N" with every upstream provider name/id stripped, so the native
 * app never learns real provider identities either. Native (Lumora-hosted)
 * sources are included and their relative /api/media URLs are absolutized so a
 * native video player can fetch them.
 *
 * No sign-in required. Native sources require a published/public title and
 * an owned episode; editor cookies never expand this public access boundary.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

function toIndex(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const type = sp.get('type');
  if (type !== 'movie' && type !== 'tv') {
    return NextResponse.json({ sources: [], error: 'invalid-request' }, { status: 400, headers: NO_STORE });
  }

  const tmdbId = sp.get('tmdbId') ?? undefined;
  const imdbId = sp.get('imdbId') ?? undefined;
  const titleIdParam = sp.get('titleId');
  const episodeIdParam = sp.get('episodeId');
  const titleId = titleIdParam && UUID_RE.test(titleIdParam) ? titleIdParam : undefined;
  const episodeId = episodeIdParam && UUID_RE.test(episodeIdParam) ? episodeIdParam : undefined;
  if ((!tmdbId && !imdbId && !titleId) || (titleIdParam !== null && !titleId) || (episodeIdParam !== null && !episodeId)
    || sp.getAll('titleId').length > 1 || sp.getAll('episodeId').length > 1 || (episodeId && (!titleId || type !== 'tv'))) {
    return NextResponse.json({ sources: [], error: 'invalid-request' }, { status: 400, headers: NO_STORE });
  }

  const season = type === 'tv' ? toIndex(sp.get('season')) : undefined;
  const episode = type === 'tv' ? toIndex(sp.get('episode')) : undefined;
  const start = toIndex(sp.get('start'));

  const playbackRequest: PlaybackRequest = {
    titleId: titleId ?? '',
    type,
    ...(tmdbId ? { tmdbId } : {}),
    ...(imdbId ? { imdbId } : {}),
    ...(episodeId ? { episodeId } : {}),
    ...(season !== undefined ? { season } : {}),
    ...(episode !== undefined ? { episode } : {}),
  };

  let nativeSources: PlaybackSource[] = [];
  if (features.supabaseConfigured && titleId) {
    const { resolveNativeSources, NativePlaybackAccessError } = await import('@/features/playback/native-sources');
    try {
      nativeSources = await resolveNativeSources(titleId, episodeId, type);
    } catch (error) {
      if (error instanceof NativePlaybackAccessError) {
        return NextResponse.json({ sources: [], error: error.status === 404 ? 'not-found' : 'playback-unavailable' },
          { status: error.status, headers: NO_STORE });
      }
      // A source outage may use provider fallback, but an access rejection may not.
    }
  }

  const [resolved, commerceContext] = await Promise.all([
    resolvePlayback(playbackRequest),
    getPlaybackCommerceContext(request),
  ]);

  // Anything the provider documents a resume parameter for gets `start`
  // appended (the native app passes the viewer's saved position).
  const startParams = new Map(getActiveProviderConfigs().map((c) => [c.id, c.startParam] as const));
  const withResume = (source: PlaybackSource): PlaybackSource => {
    if (!source.url || start === undefined || start <= 30 || !source.providerId) return source;
    const param = startParams.get(source.providerId);
    if (!param) return source;
    const joiner = source.url.includes('?') ? '&' : '?';
    return { ...source, url: `${source.url}${joiner}${new URLSearchParams([[param, String(start)]])}` };
  };

  const origin = request.nextUrl.origin;
  let subtitleCatalogUrl: string | undefined;
  if (tmdbId && /^[1-9]\d{0,9}$/.test(tmdbId) && (type === 'movie' || (season !== undefined && episode !== undefined && episode > 0))) {
    const subtitleParams = new URLSearchParams({ tmdbId, type });
    if (type === 'tv') { subtitleParams.set('season', String(season)); subtitleParams.set('episode', String(episode)); }
    subtitleCatalogUrl = `${origin}/api/subtitles?${subtitleParams.toString()}`;
  }
  const introPath = introCatalogPath({ type, imdbId, season, episode });
  const introCatalogUrl = introPath ? new URL(introPath, origin).href : undefined;
  const navigationPath = features.tmdbConfigured
    && ['type', 'tmdbId', 'season', 'episode'].every((key) => sp.getAll(key).length === 1)
    && sp.get('season') === String(season) && sp.get('episode') === String(episode)
    ? episodeNavigationPath({ type, tmdbId, season, episode }) : undefined;
  const episodeNavigationUrl = navigationPath ? new URL(navigationPath, origin).href : undefined;
  // Resume first (needs the real provider id), THEN anonymize — so the public
  // payload never carries an upstream identity.
  let fallbackIndex = 0;
  const publicSources = [...resolved.sources.map(withResume), ...nativeSources].map((s, i) => {
    const absolute = s.url && s.url.startsWith('/') ? `${origin}${s.url}` : s.url;
    return {
      id: `server-${i + 1}`,
      label: s.streamCatalogUrl ? 'Direct' : `Server ${++fallbackIndex}`,
      url: absolute,
      kind: s.kind,
      consentRequired: s.consentRequired ?? true,
      ...(s.streamCatalogUrl ? { streamCatalogUrl: new URL(s.streamCatalogUrl, origin).href } : {}),
    };
  });

  return NextResponse.json({ sources: publicSources, adPolicy: commerceContext.ads, entitlements: commerceContext.entitlements,
    ...(subtitleCatalogUrl ? { subtitleCatalogUrl } : {}),
    ...(episodeNavigationUrl ? { episodeNavigationUrl } : {}),
    ...(introCatalogUrl ? { introCatalogUrl } : {}) }, { headers: NO_STORE });
}
