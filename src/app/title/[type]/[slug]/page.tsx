import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { publicEnv } from '@/lib/env';
import { getTitleBySlug } from '@/features/catalog/queries';
import type { Title, TitleType } from '@/features/catalog/types';
import { TitleDetail, type TitleAvailability } from '@/features/catalog/components/TitleDetail';
import { truncate } from '@/features/catalog/components/title-detail-helpers';
import { resolveTitleExternalIds } from '@/features/player/title-external-ids';
import { resolvePlayback } from '@/lib/providers/registry';
import type { PlaybackRequest } from '@/lib/providers/types';

const TITLE_TYPES: readonly TitleType[] = ['movie', 'tv'];

function isTitleType(value: string): value is TitleType {
  return (TITLE_TYPES as readonly string[]).includes(value);
}

function canonicalUrl(type: TitleType, slug: string): string {
  return new URL(`/title/${type}/${slug}`, publicEnv.NEXT_PUBLIC_APP_URL).toString();
}

type TitleParams = { params: Promise<{ type: string; slug: string }> };

export async function generateMetadata({ params }: TitleParams): Promise<Metadata> {
  const { type, slug } = await params;
  if (!isTitleType(type)) {
    return { title: 'Title not found', robots: { index: false, follow: false } };
  }

  const title = await getTitleBySlug(type, slug);
  if (!title) {
    return { title: 'Title not found', robots: { index: false, follow: false } };
  }

  const description = truncate(title.synopsis, 160);
  const url = canonicalUrl(type, slug);

  return {
    title: title.name,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: title.name,
      description,
      url,
      siteName: publicEnv.NEXT_PUBLIC_APP_NAME,
      type: type === 'movie' ? 'video.movie' : 'video.tv_show',
    },
    twitter: {
      card: 'summary_large_image',
      title: title.name,
      description,
    },
  };
}

/**
 * Serialize a JSON-LD object for safe embedding inside a <script> element.
 * `JSON.stringify` does NOT escape `<`, `>`, or `&`, so a title name or synopsis
 * containing `</script><script>…` would break out of the JSON-LD block and
 * execute — a stored-XSS sink once TMDB-sourced or editor-authored text flows
 * into these fields. Escaping the three characters to their `\uXXXX` forms keeps
 * the payload valid JSON while making script-tag breakout impossible.
 */
function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** JSON-LD structured data (Section 16): Movie / TVSeries. */
function buildJsonLd(title: Title, url: string): Record<string, unknown> {
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': title.type === 'movie' ? 'Movie' : 'TVSeries',
    name: title.name,
    description: title.synopsis,
    url,
    datePublished: String(title.releaseYear),
    genre: title.genres,
    contentRating: title.maturity,
  };
  if (title.originalName && title.originalName !== title.name) {
    data.alternateName = title.originalName;
  }
  if (typeof title.score === 'number') {
    data.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: (title.score / 10).toFixed(1),
      bestRating: '10',
      worstRating: '0',
      ratingCount: 1,
    };
  }
  return data;
}

/**
 * Resolve real playback availability SERVER-SIDE (Spec Section 0: never claim a
 * source works without verifying it). We run the same provider resolution the
 * watch route uses, and map the result to the badge state the detail page
 * shows — so titles with no authorized source are honestly labeled
 * "unavailable" (Play disabled) instead of showing a green "Streaming now" dot
 * that leads to a dead player.
 *
 * When a source DOES resolve we return 'available' and keep Play enabled even
 * if the provider is consent-gated: the consent step lives on the /watch route
 * (PlayerShell), so treating consent as "unplayable" here would make every
 * title a dead-end that never reaches its own consent gate.
 */
async function resolveAvailability(title: Title): Promise<TitleAvailability> {
  const external = resolveTitleExternalIds(title);
  const request: PlaybackRequest = {
    titleId: title.id,
    type: title.type,
    ...(external.tmdbId ? { tmdbId: external.tmdbId } : {}),
    ...(external.imdbId ? { imdbId: external.imdbId } : {}),
  };
  const resolved = await resolvePlayback(request);
  return resolved.source ? 'available' : 'unavailable';
}

export default async function TitlePage({ params }: TitleParams) {
  const { type, slug } = await params;
  if (!isTitleType(type)) {
    notFound();
  }

  const title = await getTitleBySlug(type, slug);
  if (!title) {
    notFound();
  }

  const availability = await resolveAvailability(title);
  const jsonLd = buildJsonLd(title, canonicalUrl(type, slug));

  return (
    <>
      {/* Escaped so title/synopsis text can never break out of the script tag. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      <TitleDetail title={title} availability={availability} />
    </>
  );
}
