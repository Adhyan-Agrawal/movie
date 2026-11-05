import type { TitleType } from './lib/types';

/**
 * Navigation contract shared by every screen. Keeping the param lists in one
 * typed place means screens can't drift out of sync with the navigator.
 */
export type RootStackParamList = {
  Tabs: undefined;
  Title: { type: TitleType; slug: string };
  Player: {
    /** Catalog title id (uuid) — used for native sources + progress. */
    titleId: string;
    type: TitleType;
    slug: string;
    name: string;
    /** Artwork, so the guest continue-watching card shows a poster. */
    posterUrl?: string;
    backdropUrl?: string;
    tmdbId?: string;
    imdbId?: string;
    season?: number;
    episode?: number;
    episodeId?: string;
    /** Episode title, for the "Up next" affordance. */
    episodeName?: string;
    nextSeason?: number;
    nextEpisode?: number;
    /** Next episode's title, when the caller knows it (falls back to S# E# only). */
    nextEpisodeName?: string;
    /** Optional v1 room code supplied by a verified app/deep link. */
    party?: string;
  };
  WatchPartyLink: {
    type: string;
    slug: string;
    party?: string;
    season?: number;
    episode?: number;
  };
  Person: { id: string };
  Auth: undefined;
};

export type TabParamList = {
  Home: undefined;
  Search: undefined;
  MyList: undefined;
  Account: undefined;
};
