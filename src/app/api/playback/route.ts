import { NextRequest, NextResponse } from 'next/server';
import { features } from '@/lib/env';
import { listProviderConfigs } from '@/lib/providers/config';
import { resolvePlayback } from '@/lib/providers/registry';
import type { PlaybackRequest, PlaybackSource } from '@/lib/providers/types';

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
 * No auth: this is the same public information the web watch page already
 * serves to any visitor. Nothing provider-specific or secret is returned.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toIndex(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const type = sp.get('type');
  if (type !== 'movie' && type !== 'tv') {
    return NextResponse.json({ sources: [], error: 'invalid-request' }, { status: 400 });
  }

  const tmdbId = sp.get('tmdbId') ?? undefined;
  const imdbId = sp.get('imdbId') ?? undefined;
  if (!tmdbId && !imdbId) {
    return NextResponse.json({ sources: [], error: 'invalid-request' }, { status: 400 });
  }

  const season = type === 'tv' ? toIndex(sp.get('season')) : undefined;
  const episode = type === 'tv' ? toIndex(sp.get('episode')) : undefined;
  const titleId = sp.get('titleId') ?? undefined;
  const episodeId = sp.get('episodeId') ?? undefined;
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

  const resolved = await resolvePlayback(playbackRequest);

  // Native (Lumora-hosted) sources outrank embeds, exactly like the web route.
  let nativeSources: PlaybackSource[] = [];
  if (features.supabaseConfigured && titleId) {
    try {
      const { resolveNativeSources } = await import('@/features/playback/native-sources');
      nativeSources = await resolveNativeSources(titleId, episodeId);
    } catch (err) {
      console.warn('api.playback: native sources failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Anything the provider documents a resume parameter for gets `start`
  // appended (the native app passes the viewer's saved position).
  const startParams = new Map(listProviderConfigs().map((c) => [c.id, c.startParam] as const));
  const withResume = (source: PlaybackSource): PlaybackSource => {
    if (!source.url || start === undefined || start <= 30 || !source.providerId) return source;
    const param = startParams.get(source.providerId);
    if (!param) return source;
    const joiner = source.url.includes('?') ? '&' : '?';
    return { ...source, url: `${source.url}${joiner}${param}=${start}` };
  };

  const origin = request.nextUrl.origin;
  // Resume first (needs the real provider id), THEN anonymize — so the public
  // payload never carries an upstream identity.
  const publicSources = [...nativeSources, ...resolved.sources.map(withResume)].map((s, i) => {
    const absolute = s.url && s.url.startsWith('/') ? `${origin}${s.url}` : s.url;
    return {
      id: `server-${i + 1}`,
      label: `Server ${i + 1}`,
      url: absolute,
      kind: s.kind,
      consentRequired: s.consentRequired ?? true,
    };
  });

  return NextResponse.json({ sources: publicSources }, { headers: { 'Cache-Control': 'no-store' } });
}
