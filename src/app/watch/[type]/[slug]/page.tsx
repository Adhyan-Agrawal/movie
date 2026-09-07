import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { features } from '@/lib/env';
import { getTitleBySlug } from '@/features/catalog/queries';
import type { TitleType } from '@/features/catalog/types';
import { getProviderConfig, listProviderConfigs } from '@/lib/providers/config';
import type { PlaybackRequest, PlaybackSource } from '@/lib/providers/types';
import { resolvePlayback } from '@/lib/providers/registry';
import { PlayerShell } from '@/features/player/PlayerShell';
import { EpisodeNavLinks, type EpisodeNavTarget } from '@/features/player/EpisodeNavLinks';
import { resolveTitleExternalIds } from '@/features/player/title-external-ids';
import { getAdSlot } from '@/features/ads/config';
import { AdSlot } from '@/features/ads/AdSlot';
import { ConsentGate } from '@/features/ads/ConsentGate';

/**
 * Watch route (Spec Section 3 & 9). Server component: loads the title, resolves
 * a sanitized playback source SERVER-SIDE via the provider registry, and hands
 * only safe data to the client player. Prioritizes video with minimal chrome.
 *
 * Indexing: player states are `noindex` (Spec Section 16) — see generateMetadata.
 */

type RouteParams = { type: string; slug: string };
type RouteSearch = { season?: string | string[]; episode?: string | string[] };

function isTitleType(value: string): value is TitleType {
  return value === 'movie' || value === 'tv';
}

function toIndex(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const robots = { index: false, follow: false } as const;
  const { type, slug } = await params;
  if (!isTitleType(type)) return { title: 'Watch', robots };
  const title = await getTitleBySlug(type, slug);
  if (!title) return { title: 'Watch', robots };
  return {
    title: `Watch ${title.name}`,
    description: `Play ${title.name} on Lumora.`,
    robots,
  };
}

export default async function WatchPage({
  params,
  searchParams,
}: {
  params: Promise<RouteParams>;
  searchParams: Promise<RouteSearch>;
}) {
  const { type, slug } = await params;
  if (!isTitleType(type)) notFound();

  const title = await getTitleBySlug(type, slug);
  if (!title) notFound();

  const { season: seasonParam, episode: episodeParam } = await searchParams;
  const season = toIndex(seasonParam);
  const episode = toIndex(episodeParam);

  // TV without a specific episode: deep-link to the first available one instead
  // of sending the provider a whole-series URL. vidup (Server 4) and 2embed
  // (Server 2) only document episode-shaped routes — `/tv/{id}` / `/embedtvfull`
  // fail, so a series Play button used to dead-end. Resolving S1E1 (or the real
  // first episode when imported) means every provider builds its concrete
  // episode URL and playback starts.
  if (title.type === 'tv' && (season === undefined || episode === undefined)) {
    let firstSeason = 1;
    let firstEpisode = 1;
    if (features.supabaseConfigured) {
      try {
        const { listSeasonsForTitle } = await import('@/features/catalog/queries');
        const seasons = await listSeasonsForTitle(title.id);
        const first = seasons.find((s) => s.episodes.length > 0);
        if (first && first.episodes[0]) {
          firstSeason = first.seasonNumber;
          firstEpisode = first.episodes[0].episodeNumber;
        }
      } catch (err) {
        console.warn('playback.firstEpisodeLookup failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    redirect(`/watch/tv/${title.slug}?season=${firstSeason}&episode=${firstEpisode}`);
  }

  // TV: resolve the exact episode row so native sources and watch progress can
  // target it (provider embeds build URLs from season/episode numbers instead).
  let episodeId: string | undefined;
  if (title.type === 'tv' && season !== undefined && episode !== undefined && features.supabaseConfigured) {
    try {
      const { findEpisodeId } = await import('@/features/playback/native-sources');
      episodeId = (await findEpisodeId(title.id, season, episode)) ?? undefined;
    } catch (err) {
      console.warn('playback.episodeLookup failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // On-demand enrichment (Spec Section 4): a series whose episodes weren't
    // fully imported is backfilled from TMDB on first view, so a deep link to
    // an episode resolves. Best-effort — if it still fails, the player mounts
    // from the season/episode numbers alone.
    if (!episodeId) {
      try {
        const { ensureTitleComplete } = await import('@/features/catalog/title-enrichment');
        await ensureTitleComplete(title.id);
      } catch (err) {
        console.warn('playback.enrichment failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        const { findEpisodeId } = await import('@/features/playback/native-sources');
        episodeId = (await findEpisodeId(title.id, season, episode)) ?? undefined;
      } catch (err) {
        console.warn('playback.episodeLookup (retry) failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Episode index + previous/next (TV only). Flattened in season order so
  // "previous" crosses back into the last episode of the prior season and
  // "next" rolls forward into the next season's first episode.
  let episodeNav:
    | { current: EpisodeNavTarget; previous?: EpisodeNavTarget; next?: EpisodeNavTarget }
    | undefined;
  if (title.type === 'tv' && season !== undefined && episode !== undefined && features.supabaseConfigured) {
    try {
      const { listSeasonsForTitle } = await import('@/features/catalog/queries');
      const seasons = await listSeasonsForTitle(title.id);
      const flat = seasons.flatMap((s) =>
        s.episodes.map((e) => ({ season: s.seasonNumber, episode: e.episodeNumber })),
      );
      const idx = flat.findIndex((e) => e.season === season && e.episode === episode);
      if (idx >= 0) {
        const target = (i: number): EpisodeNavTarget => ({
          season: flat[i]!.season,
          episode: flat[i]!.episode,
          label: `S${flat[i]!.season} E${flat[i]!.episode}`,
        });
        episodeNav = {
          current: target(idx),
          ...(idx > 0 ? { previous: target(idx - 1) } : {}),
          ...(idx < flat.length - 1 ? { next: target(idx + 1) } : {}),
        };
      }
    } catch (err) {
      console.warn('playback.episodeNav failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The title's own TMDB/IMDb ids from the catalog row drive playback resolution.
  const external = resolveTitleExternalIds(title);

  const request: PlaybackRequest = {
    titleId: title.id,
    type: title.type,
    ...(episodeId ? { episodeId } : {}),
    ...(external.tmdbId ? { tmdbId: external.tmdbId } : {}),
    ...(external.imdbId ? { imdbId: external.imdbId } : {}),
    ...(title.type === 'tv' && season !== undefined ? { season } : {}),
    ...(title.type === 'tv' && episode !== undefined ? { episode } : {}),
  };

  const resolved = await resolvePlayback(request);
  const providerConfig = getProviderConfig('vidsrc');

  // Native media sources (Spec Section 9): Lumora-hosted mp4/hls/dash rows.
  // `media_sources` is provider-managed (not public under RLS), so resolution
  // runs server-side with the service client and returns sanitized sources —
  // storage rows become 4h signed URLs. A failure degrades to embeds only.
  let nativeSources: PlaybackSource[] = [];
  if (features.supabaseConfigured) {
    try {
      const { resolveNativeSources } = await import('@/features/playback/native-sources');
      nativeSources = await resolveNativeSources(title.id, episodeId);
    } catch (err) {
      console.warn('playback.nativeSources failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Watch-resume: the signed-in viewer's saved position for this title/episode
  // (anonymous viewers and finished/barely-started titles resume nothing).
  let resumePos: { positionSeconds: number; progress: number } | null = null;
  if (features.supabaseConfigured) {
    try {
      const { getResumePosition } = await import('@/features/playback/progress-queries');
      resumePos = await getResumePosition(title.id, episodeId);
    } catch (err) {
      console.warn('playback.resumeLookup failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Embed resume: providers that document a start parameter (only vidup today,
  // via ProviderConfig.startParam) get the saved position appended to their
  // URL — but only once it is meaningfully past the start (> 30s).
  const resumeSeconds = resumePos?.positionSeconds ?? 0;
  const providerConfigs = new Map(listProviderConfigs().map((c) => [c.id, c] as const));
  const embedSources = resolved.sources.map((s) => {
    if (!s.url || resumeSeconds <= 30 || !s.providerId) return s;
    const config = providerConfigs.get(s.providerId);
    if (!config?.startParam) return s;
    const joiner = s.url.includes('?') ? '&' : '?';
    return { ...s, url: `${s.url}${joiner}${config.startParam}=${Math.round(resumeSeconds)}` };
  });

  // Pre-roll ad zone (Spec Section 11): resolved server-side so the key never
  // ships to the client except inside Adsterra's public embed pattern.
  const prerollSlot = getAdSlot('watchPreroll');
  const preroll = prerollSlot.adsterraKey
    ? { adsterraKey: prerollSlot.adsterraKey, width: prerollSlot.width, height: prerollSlot.height }
    : null;

  // Safe diagnostics only (Spec Section 9): title id, type, and whether a
  // source resolved. Never log the provider id/name, iframe URL, query
  // strings, or tokens — the public payload must not name the upstream source.
  console.warn('playback.resolve', {
    titleId: title.id,
    type: title.type,
    sourceKind: resolved.source?.kind ?? null,
    ok: resolved.source !== null,
  });

  // PUBLIC SOURCE LABELING: the public player never names the upstream
  // provider — not in labels, ids, or serialized props. Native sources merge
  // FIRST (Lumora's own media outranks third-party embeds, so a native upload
  // is "Server 1" and the provider embeds shift down), then every source is
  // branded "Server 1", "Server 2", … in merge order; every identifying field
  // is overwritten so nothing upstream reaches the client payload. The real
  // provider identity stays in the admin console and server logs. The consent
  // copy in PlayerShell still discloses that embed playback runs via an
  // EXTERNAL service (cookies/terms apply) — just unbranded.
  const publicSources: PlaybackSource[] = [...nativeSources, ...embedSources].map((s, i) => ({
    ...s,
    id: `server-${i + 1}`,
    label: `Server ${i + 1}`,
    providerId: `server-${i + 1}`,
    providerLabel: `Server ${i + 1}`,
  }));
  const providerLabel = 'Server 1';
  const consentRequired = resolved.source?.consentRequired ?? providerConfig?.consentRequired ?? true;

  return (
    <Container className="py-4 md:py-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <PlayerShell
          title={{
            id: title.id,
            name: title.name,
            slug: title.slug,
            type: title.type,
            ...(title.posterUrl ? { posterUrl: title.posterUrl } : {}),
          }}
          source={publicSources[0] ?? resolved.source}
          error={resolved.error}
          sources={publicSources}
          providerLabel={providerLabel}
          consentRequired={consentRequired}
          {...(episodeId ? { episodeId } : {})}
          {...(title.type === 'tv' && season !== undefined ? { seasonNumber: season } : {})}
          {...(title.type === 'tv' && episode !== undefined ? { episodeNumber: episode } : {})}
          {...(resumePos ? { initialPosition: resumePos.positionSeconds } : {})}
          preroll={preroll}
        />

        {/* Episode navigation (TV only): next/previous across season
            boundaries, computed server-side from the real episode index. */}
        {episodeNav ? (
          <EpisodeNavLinks
            baseHref={`/watch/tv/${title.slug}`}
            current={episodeNav.current}
            previous={episodeNav.previous}
            next={episodeNav.next}
          />
        ) : null}

        {/* Ad (Spec Section 11): one banner below the player header — never
            above the fold of the player itself. */}
        <ConsentGate><AdSlot slot="watchBanner" /></ConsentGate>

        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {title.type === 'tv' ? <Badge tone="info">Series</Badge> : null}
            <Badge tone="neutral">{title.maturity}</Badge>
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight md:text-3xl">{title.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-content-muted">
            <span>{title.releaseYear}</span>
            {title.genres.length ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{title.genres.join(', ')}</span>
              </>
            ) : null}
          </div>
          <p className="max-w-2xl text-sm leading-relaxed text-content-muted">{title.synopsis}</p>
        </header>

        <div>
          <Link
            href={`/title/${title.type}/${title.slug}`}
            className={buttonClasses({ variant: 'ghost', size: 'sm' })}
          >
            View full title details
          </Link>
        </div>
      </div>
    </Container>
  );
}
