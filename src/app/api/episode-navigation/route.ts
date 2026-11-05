import { NextRequest, NextResponse } from 'next/server';
import { features } from '@/lib/env';
import { getTmdbShowMetadata, getTmdbSeasonMetadata } from '@/features/catalog/tmdb-catalog';
import { slugify } from '@/features/catalog/tmdb-normalize';
import {
  parseEpisodeNavigationRequest,
  parseEpisodeNavigation,
  type EpisodeNavigation,
  type EpisodeNavigationRequest,
  type EpisodeNavigationTarget,
} from '@/features/player/episode-navigation';
import { cacheEpisodeNavigation, readEpisodeNavigationCache } from '@/features/player/episode-navigation-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SeasonSummary = { id: number; seasonNumber: number };
type Episode = Omit<EpisodeNavigationTarget, 'href'>;
type Read = <T>(lookup: () => Promise<T>) => Promise<T>;
type Resolution = { navigation: EpisodeNavigation; verified: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function index(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 999;
}

function label(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function showMetadata(value: unknown, input: EpisodeNavigationRequest): { slug: string; seasons: SeasonSummary[] } | null {
  if (!record(value) || value.id !== Number(input.tmdbId) || !label(value.name)
    || !Array.isArray(value.seasons) || value.seasons.length > 1000) return null;
  const slug = `${slugify(value.name)}-${input.tmdbId}`;
  if (slug.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  const numbers = new Set<number>();
  const ids = new Set<number>();
  const seasons: SeasonSummary[] = [];
  for (const row of value.seasons) {
    if (!record(row) || !positiveId(row.id) || !index(row.season_number, 0)
      || numbers.has(row.season_number) || ids.has(row.id)) return null;
    numbers.add(row.season_number);
    ids.add(row.id);
    seasons.push({ id: row.id, seasonNumber: row.season_number });
  }
  return { slug, seasons: seasons.sort((a, b) => a.seasonNumber - b.seasonNumber) };
}

function aired(value: unknown, today: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1878-01-01' || value > today) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function seasonEpisodes(value: unknown, summary: SeasonSummary, today: string): { episodes: Episode[]; complete: boolean } | null {
  if (!record(value) || value.id !== summary.id || value.season_number !== summary.seasonNumber
    || !Array.isArray(value.episodes) || value.episodes.length > 999) return null;
  const numbers = new Set<number>();
  const ids = new Set<number>();
  const episodes: Episode[] = [];
  let complete = true;
  for (const row of value.episodes) {
    if (!record(row) || row.season_number !== summary.seasonNumber || !index(row.episode_number, 1)) { complete = false; continue; }
    if (numbers.has(row.episode_number) || (positiveId(row.id) && ids.has(row.id))) return null;
    numbers.add(row.episode_number);
    if (positiveId(row.id)) ids.add(row.id);
    if (!positiveId(row.id) || !label(row.name)) { complete = false; continue; }
    if (!aired(row.air_date, today)) {
      if (!aired(row.air_date, '9999-12-31')) complete = false;
      continue;
    }
    episodes.push({ seasonNumber: summary.seasonNumber, episodeNumber: row.episode_number, name: row.name.trim() });
  }
  return { episodes: episodes.sort((a, b) => a.episodeNumber - b.episodeNumber), complete };
}

async function resolveNavigation(input: EpisodeNavigationRequest, read: Read, stopped: () => boolean): Promise<Resolution> {
  const empty: Resolution = { navigation: { previous: null, next: null }, verified: false };
  const show = showMetadata(await read(() => getTmdbShowMetadata(input.tmdbId)), input);
  if (!show) return empty;
  // Specials have no verified ordering relative to regular seasons.
  const seasons = show.seasons.filter((season) => input.season === 0 ? season.seasonNumber === 0 : season.seasonNumber > 0);
  const seasonIndex = seasons.findIndex((season) => season.seasonNumber === input.season);
  const currentSeason = seasons[seasonIndex];
  if (!currentSeason) return empty;
  const today = new Date().toISOString().slice(0, 10);
  const currentData = seasonEpisodes(await read(() => getTmdbSeasonMetadata(input.tmdbId, input.season)), currentSeason, today);
  const current = currentData?.episodes;
  const episodeIndex = current?.findIndex((episode) => episode.episodeNumber === input.episode) ?? -1;
  if (!current || !currentData || episodeIndex < 0) return empty;
  let verified = currentData.complete;
  const target = (episode: Episode | undefined): EpisodeNavigationTarget | null => episode ? {
    ...episode,
    href: `/watch/tv/${show.slug}?${new URLSearchParams({ season: String(episode.seasonNumber), episode: String(episode.episodeNumber) })}`,
  } : null;
  const adjacent = async (direction: -1 | 1): Promise<EpisodeNavigationTarget | null> => {
    const episode = current[episodeIndex + direction];
    if (episode) return target(episode);
    const summary = seasons[seasonIndex + direction];
    if (!summary) return null;
    try {
      const data = seasonEpisodes(await read(() => getTmdbSeasonMetadata(input.tmdbId, summary.seasonNumber)), summary, today);
      if (!data?.complete || !data.episodes.length) verified = false;
      return target(direction === -1 ? data?.episodes.at(-1) : data?.episodes[0]);
    } catch (error) {
      if (stopped()) throw error;
      verified = false;
      return null;
    }
  };
  const [previous, next] = await Promise.all([adjacent(-1), adjacent(1)]);
  return { navigation: { previous, next }, verified: verified && today === new Date().toISOString().slice(0, 10) };
}

function response(body: EpisodeNavigation, status = 200, cacheControl = 'private, no-store'): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const input = parseEpisodeNavigationRequest(request.nextUrl.searchParams);
  const empty: EpisodeNavigation = { previous: null, next: null };
  if (!input) return response(empty, 400);
  if (!features.tmdbConfigured || request.signal.aborted) return response(empty);
  const cached = readEpisodeNavigationCache(input);
  if (cached) return response(cached.navigation, 200, cached.cacheControl);

  let stopped = false;
  let cancel!: () => void;
  const canceled = new Promise<never>((_, reject) => {
    cancel = () => { stopped = true; reject(new Error('Episode navigation unavailable.')); };
  });
  request.signal.addEventListener('abort', cancel, { once: true });
  // Existing public TMDB reads own their cache and fetch deadline. Cancel only
  // this waiter, so a disconnected viewer cannot poison shared public metadata.
  const timer = setTimeout(cancel, 8000);
  const read: Read = async (lookup) => {
    if (stopped) throw new Error('Episode navigation unavailable.');
    return Promise.race([lookup(), canceled]);
  };
  try {
    const resolved = await resolveNavigation(input, read, () => stopped);
    const navigation = parseEpisodeNavigation(resolved.navigation, request.nextUrl.origin);
    if (!navigation || stopped) return response(empty);
    const cached = resolved.verified ? cacheEpisodeNavigation(input, navigation, request.nextUrl.origin) : null;
    return response(navigation, 200, cached?.cacheControl);
  } catch {
    return response(empty);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', cancel);
  }
}
