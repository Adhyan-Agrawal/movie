import 'server-only';

import type { Capabilities, PlaybackSource } from '@/lib/providers/types';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import type { MediaSourceKindEnum } from '@/lib/supabase/types';
import { getSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Native media-source resolution (Spec Section 9).
 *
 * `media_sources` rows (raw URLs and storage references) are provider-managed
 * and NOT publicly readable under RLS, so this module reads them with the
 * service client and returns only sanitized, client-safe PlaybackSource DTOs:
 * for storage-backed rows that means a time-limited SIGNED URL (the `media`
 * bucket is private — nothing is ever public), and for remote rows the
 * admin-configured URL itself. Failures degrade to an empty list so playback
 * falls back to provider embeds rather than erroring into the page.
 */

/** Signed storage URL lifetime: long enough for a feature film, short enough
 *  to limit the blast radius of a leaked link. */
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 4;

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
): Promise<PlaybackSource[]> {
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
    console.warn('playback.resolveNativeSources: media_sources read failed', {
      message: error.message,
    });
    return [];
  }

  const sources: PlaybackSource[] = [];
  for (const row of rows ?? []) {
    if (!isNativeKind(row.kind)) continue;

    // Storage-backed media never goes public. For HLS we must serve via the
    // /api/media proxy: a signed URL works for the master playlist but not for
    // the relative child playlists/segments hls.js resolves (the signature is
    // dropped), so they'd 401. The proxy streams the whole tree from the
    // private bucket server-side. Single-file mp4/dash keep a 4h signed URL.
    let url = row.url;
    if (!url && row.reference) {
      if (row.kind === 'hls') {
        url = `/api/media/${row.reference}`;
      } else {
        const { data, error: signError } = await service.storage
          .from('media')
          .createSignedUrl(row.reference, SIGNED_URL_TTL_SECONDS);
        if (signError || !data?.signedUrl) {
          console.warn('playback.resolveNativeSources: signed URL failed, skipping source', {
            message: signError?.message ?? 'no signed URL returned',
          });
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
 * uses the request-scoped client — the service client is reserved for
 * media_sources and storage. Returns null when the episode does not exist.
 */
export async function findEpisodeId(
  titleId: string,
  season: number,
  episode: number,
): Promise<string | null> {
  const db = await getSupabaseServerClient();

  const { data: seasonRow, error: seasonError } = await db
    .from('seasons')
    .select('id')
    .eq('title_id', titleId)
    .eq('season_number', season)
    .maybeSingle();
  if (seasonError) {
    console.warn('playback.findEpisodeId: seasons read failed', { message: seasonError.message });
    return null;
  }
  if (!seasonRow) return null;

  const { data: episodeRow, error: episodeError } = await db
    .from('episodes')
    .select('id')
    .eq('season_id', seasonRow.id)
    .eq('episode_number', episode)
    .maybeSingle();
  if (episodeError) {
    console.warn('playback.findEpisodeId: episodes read failed', { message: episodeError.message });
    return null;
  }
  return episodeRow?.id ?? null;
}
