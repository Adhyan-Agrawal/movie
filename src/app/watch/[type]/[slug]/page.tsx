import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';
import { getTitleBySlug } from '@/features/catalog/queries';
import type { TitleType } from '@/features/catalog/types';
import { getProviderConfig } from '@/lib/providers/config';
import type { PlaybackRequest } from '@/lib/providers/types';
import { resolvePlayback } from '@/lib/providers/registry';
import { PlayerShell } from '@/features/player/PlayerShell';
import { resolveTitleExternalIds } from '@/features/player/title-external-ids';
import { getAdSlot } from '@/features/ads/config';
import { AdSlot } from '@/features/ads/AdSlot';

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

  // The title's own TMDB/IMDb ids from the catalog row drive playback resolution.
  const external = resolveTitleExternalIds(title);

  const request: PlaybackRequest = {
    titleId: title.id,
    type: title.type,
    ...(external.tmdbId ? { tmdbId: external.tmdbId } : {}),
    ...(external.imdbId ? { imdbId: external.imdbId } : {}),
    ...(title.type === 'tv' && season !== undefined ? { season } : {}),
    ...(title.type === 'tv' && episode !== undefined ? { episode } : {}),
  };

  const resolved = await resolvePlayback(request);
  const providerConfig = getProviderConfig('vidsrc');

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
  // provider — not in labels, ids, or serialized props. Sources are branded
  // "Server 1", "Server 2", … in resolution order; every identifying field is
  // overwritten so nothing upstream reaches the client payload. The real
  // provider identity stays in the admin console and server logs. The consent
  // copy in PlayerShell still discloses that playback runs via an EXTERNAL
  // service (cookies/terms apply) — just unbranded.
  const publicSources = resolved.sources.map((s, i) => ({
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
          title={{ name: title.name, slug: title.slug, type: title.type }}
          source={publicSources[0] ?? resolved.source}
          error={resolved.error}
          sources={publicSources}
          providerLabel={providerLabel}
          consentRequired={consentRequired}
          preroll={preroll}
        />

        {/* Ad (Spec Section 11): one banner below the player header — never
            above the fold of the player itself. */}
        <AdSlot slot="watchBanner" />

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
