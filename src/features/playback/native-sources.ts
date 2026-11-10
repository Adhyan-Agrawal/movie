import 'server-only';

import type { Capabilities, PlaybackRequest, PlaybackSource } from '@/lib/providers/types';
import { getSupabasePublicClient } from '@/lib/supabase/public';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import type { MediaSourceKindEnum } from '@/lib/supabase/types';

/**
 * Native media-source resolution (Spec Section 9).
 *
 * `media_sources` rows (raw URLs and storage references) are provider-managed
 * and NOT publicly readable under RLS, so this module reads them with the
 * service client and returns only sanitized, client-safe PlaybackSource DTOs:
 * for storage-backed rows that means a time-limited SIGNED URL (the `media`
 * bucket is private — nothing is ever public), and for remote rows the
 * admin-configured URL itself. Public title/episode access is checked before
 * creating the service client. Authorization denials/errors are distinct from
 * source failures, which can still fall back to provider embeds.
 */

/** Signed storage URL lifetime: long enough for a feature film, short enough
 *  to limit the blast radius of a leaked link. */
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NativePlaybackAccessError extends Error {
  constructor(readonly status: 404 | 503) {
    super(status === 404 ? 'Native playback not found' : 'Native playback authorization unavailable');
  }
}

/** media_source kinds the native HTML5 player can actually play. */
type NativeKind = 'mp4' | 'hls' | 'dash';

function isNativeKind(kind: MediaSourceKindEnum): kind is NativeKind {
  return kind === 'mp4' || kind === 'hls' || kind === 'dash';
}

/**
 * What the native player honestly supports. Unlike embed providers it DOES
 * emit real telemetry (timeupdate/pause/ended drive watch_progress), so
 * `telemetry` is true; everything not surfaced in v1 stays false rather than
 * advertised.
 */
const NATIVE_CAPABILITIES: Capabilities = {
  fullscreen: true,
  qualitySelection: false,
  subtitles: false,
  audioTracks: false,
  playbackRate: true,
  episodeSelection: false,
  providerResume: false,
  telemetry: true,
  skipMarkers: false,
};

/**
 * Resolve the enabled native (mp4/hls/dash) media sources for a title.
 *
 * Episode scoping: when `episodeId` is given, episode-specific rows AND
 * title-level rows (episode_id null) both apply; without it only title-level
 * rows do. Rows are ordered by priority (highest first) — the watch route
 * merges the result AHEAD of provider embeds, so the top native row becomes
 * public "Server 1".
 */
export async function resolveNativeSources(
  titleId: string,
  episodeId?: string,
  type?: PlaybackRequest['type'],
): Promise<PlaybackSource[]> {
  if (!UUID_RE.test(titleId) || (episodeId !== undefined && !UUID_RE.test(episodeId))) {
    throw new NativePlaybackAccessError(404);
  }

  // This helper is also called outside the API route. Never use editor cookies
  // or the service role to decide whether a public playback URL may be issued.
  try {
    const db = getSupabasePublicClient();
    const { data: title, error: titleError } = await db.from('titles').select('id, type')
      .eq('id', titleId).eq('status', 'published').eq('visibility', 'public')
      .or(`published_at.is.null,published_at.lte.${new Date().toISOString()}`)
      .maybeSingle();
    if (titleError) throw new NativePlaybackAccessError(503);
    if (!title || (type !== undefined && title.type !== type) || (episodeId !== undefined && title.type !== 'tv')) {
      throw new NativePlaybackAccessError(404);
    }
    if (episodeId !== undefined) {
      const { data: episode, error: episodeError } = await db.from('episodes').select('id')
        .eq('id', episodeId).eq('title_id', title.id).maybeSingle();
      if (episodeError) throw new NativePlaybackAccessError(503);
      if (!episode) throw new NativePlaybackAccessError(404);
    }
  } catch (error) {
    if (error instanceof NativePlaybackAccessError) throw error;
    throw new NativePlaybackAccessError(503);
  }

  const service = getSupabaseServiceClient();

  let query = service
    .from('media_sources')
    .select('id, kind, url, reference, label, consent_required')
    .eq('title_id', titleId)
    .eq('enabled', true);
  query = episodeId
    ? query.or(`episode_id.eq.${episodeId},episode_id.is.null`)
    : query.is('episode_id', null);

  const { data: rows, error } = await query.order('priority', { ascending: false });
  if (error) {
    console.warn('playback.resolveNativeSources: media_sources read failed');
    return [];
  }

  const sources: PlaybackSource[] = [];
  for (const row of rows ?? []) {
    if (!isNativeKind(row.kind)) continue;

    // The storage bucket stays private. For HLS we must serve via the
    // /api/media proxy: a signed URL works for the master playlist but not for
    // the relative child playlists/segments hls.js resolves (the signature is
    // dropped), so they'd 401. The proxy reauthorizes registered public HLS
    // output. Single-file mp4/dash keep a 4h signed URL.
    let url = row.url;
    if (!url && row.reference) {
      if (row.kind === 'hls') {
        url = `/api/media/${row.reference}`;
      } else {
        const { data, error: signError } = await service.storage
          .from('media')
          .createSignedUrl(row.reference, SIGNED_URL_TTL_SECONDS);
        if (signError || !data?.signedUrl) {
          console.warn('playback.resolveNativeSources: signed URL failed, skipping source');
          continue;
        }
        url = data.signedUrl;
      }
    }
    if (!url) continue;

    sources.push({
      id: `native:${row.id}`,
      kind: row.kind,
      url,
      label: row.label || 'Lumora',
      capabilities: NATIVE_CAPABILITIES,
      providerId: 'lumora',
      providerLabel: 'Lumora',
      external: false,
      consentRequired: row.consent_required,
    });
  }
  return sources;
}

/**
 * Look up an episode row id by (title, season number, episode number) via the
 * seasons -> episodes join. Episodes are publicly readable under RLS, so this
 * uses the cookie-free public client; the service client is reserved for
 * media_sources and storage. Returns null when the episode does not exist.
 */
export async function findEpisodeId(
  titleId: string,
  season: number,
  episode: number,
): Promise<string | null> {
  if (!UUID_RE.test(titleId)) return null;
  const db = getSupabasePublicClient();

  const { data: seasonRow, error: seasonError } = await db
    .from('seasons')
    .select('id')
    .eq('title_id', titleId)
    .eq('season_number', season)
    .maybeSingle();
  if (seasonError) {
    console.warn('playback.findEpisodeId: seasons read failed');
    return null;
  }
  if (!seasonRow) return null;

  const { data: episodeRow, error: episodeError } = await db
    .from('episodes')
    .select('id')
    .eq('title_id', titleId)
    .eq('season_id', seasonRow.id)
    .eq('episode_number', episode)
    .maybeSingle();
  if (episodeError) {
    console.warn('playback.findEpisodeId: episodes read failed');
    return null;
  }
  return episodeRow?.id ?? null;
}
