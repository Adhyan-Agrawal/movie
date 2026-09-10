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
