import { parseWatchPartyMediaIdentity, type WatchPartyMediaIdentity } from './protocol';

export function buildWatchPartyMediaIdentity({ type, titleId, episodeId, season, episode }: {
  type: 'movie' | 'tv'; titleId: string; episodeId?: string; season?: number; episode?: number;
}): WatchPartyMediaIdentity | null {
  if ((type !== 'movie' && type !== 'tv') || typeof titleId !== 'string') return null;
  return parseWatchPartyMediaIdentity(type === 'movie'
    ? { kind: 'movie', mediaId: titleId }
    : { kind: 'episode', mediaId: titleId,
      // Public TV uses coordinates, never an unrelated/stale database episode ID.
      ...(!titleId.startsWith('tmdb:tv:') && episodeId ? { episodeId } : {}),
      ...(season !== undefined && episode !== undefined ? { seasonNumber: season, episodeNumber: episode } : {}) });
}
