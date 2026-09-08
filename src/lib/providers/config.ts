/**
 * Provider configuration (Spec Section 9: "Vidsrc/VSEmbed API integration").
 *
 * This is the SINGLE source of truth for a provider's base domain and URL
 * templates. It is intentionally centralized so that:
 *   - no production provider domain is hardcoded across multiple components, and
 *   - an administrator can change the base domain / templates through an
 *     audited setting when the provider changes its infrastructure
 *     (Spec Section 10: Sources / Settings). Today these are static defaults;
 *     a future `/admin/providers` screen will edit + audit them.
 *
 * URL templates use `{id}`, `{season}`, and `{episode}` placeholders. `{id}`
 * accepts either an IMDb id (`tt…`) or a numeric TMDB id per the documented
 * Vidsrc/VSEmbed patterns.
 *
 * DOCUMENTED PATTERNS — https://vsembed.su/vidsrc/docs/
 *   The four route shapes the adapter must support (Spec Section 9):
 *     1. Movie ................. moviePathTemplate         /embed/movie/{id}
 *     2. Whole TV series ....... tvSeriesPathTemplate      /embed/tv/{id}         (built-in picker)
 *     3. Specific episode ...... episodePathTemplate       /embed/tv/{id}/{season}/{episode}
 *     4. Shorthand episode ..... shorthandEpisodeTemplate  /embed/tv/{id}-{season}-{episode}
 *
 *   These default paths follow the documented Vidsrc-compatible embed routes.
 *   Because the provider may change its infrastructure, they are configuration,
 *   not constants: the operator MUST confirm the current base domain and paths
 *   against the live docs before production and adjust via the audited admin
 *   setting. `buildVidsrcUrl` validates the constructed host against
 *   `allowedDomains` regardless, so a stale template can never produce an
 *   unsafe URL. No API key is required for the documented embed use case, but
 *   that is NOT permission for unlimited commercial use, guaranteed
 *   availability, or redistribution — the operator must review the provider's
 *   current terms, rights status, and applicable law (Spec Section 9).
 */

export interface ProviderConfig {
  /** Stable provider id used as a registry key and in safe diagnostics. */
  id: string;
  enabled: boolean;
  displayName: string;
  /** Base origin — the ONLY place a provider production domain is written. */
  baseUrl: string;
  /**
   * Hosts a constructed URL is permitted to resolve to. The adapter rejects any
   * URL whose host is not an exact match or a subdomain of an allowed domain.
   */
  allowedDomains: string[];
  moviePathTemplate: string;
  tvSeriesPathTemplate: string;
  episodePathTemplate: string;
  shorthandEpisodeTemplate: string;
  /** Higher runs first during source selection. */
  defaultPriority: number;
  /** Network timeout for health probes (ms). */
  timeoutMs: number;
  /** ISO region codes where the provider is allowed; `['*']` means everywhere. */
  enabledRegions: string[];
  /** Require an explicit viewer opt-in before loading the external iframe. */
  consentRequired: boolean;
  /** Id used to resolve: 'imdb' (default) or 'tmdb'. */
  preferredId?: 'imdb' | 'tmdb';
  /**
   * Query parameter the provider's embed accepts for resuming at a position
   * (seconds), e.g. `?startAt=120`. Undefined = the provider documents no
   * start parameter, so no resume value is ever appended to its URL.
   */
  startParam?: string;
  /** Id used by the admin "test playback" / preview action. */
  testTitleId: string;
}

/**
 * Default provider configurations. The base domain of each provider lives here
 * and ONLY here. Treat every field as admin-editable + audited in the future.
 *
 * PUBLIC NUMBERING (do not change without updating the watch route): sources
 * are labeled "Server 1..N" in registry priority order, so priority defines
 * the public server number — vidsrc.mov = Server 1, 2embed = Server 2, VSEmbed =
 * Server 3, vidup = Server 4.
 *
 * VERIFICATION STATUS (Spec Section 0 — never claim an integration works
 * without testing):
 *   - vsembed:   documented patterns; embed verified loading in a browser.
 *   - vidup:     documented on https://vidup.to/#documentation (read in a
 *                headed browser — Cloudflare blocks bots): movie
 *                `/movie/{id}`, episode `/tv/{id}/{s}/{e}` (IMDb or TMDB id).
 *                The whole-series `/tv/{id}` shape is inferred (the docs don't
 *                document one); normal flow always resolves a specific episode.
 *   - 2embed:    documented on https://www.2embed.skin/#api; live-verified in
 *                a browser: TMDB ids work (`/embed/27205`, `/embedtv/1396`).
 *                IMDb ids currently redirect to a dead page on their
 *                migrating infrastructure, so this provider prefers TMDB.
 *   - vidsrc.mov: documented on https://vidsrc.mov/#api: `/embed/movie/{id}`,
 *                `/embed/tv/{id}/{s}/{e}`.
 */
export const VIDUP_PROVIDER_CONFIG: ProviderConfig = {
  id: 'vidup',
  enabled: true,
  displayName: 'VidUp',
  baseUrl: 'https://vidup.to',
  allowedDomains: ['vidup.to'],
  moviePathTemplate: '/movie/{id}',
  tvSeriesPathTemplate: '/tv/{id}',
  episodePathTemplate: '/tv/{id}/{season}/{episode}',
  shorthandEpisodeTemplate: '/tv/{id}/{season}/{episode}',
  defaultPriority: 100, // Server 4
  timeoutMs: 8000,
  enabledRegions: ['*'],
  consentRequired: true,
  // Both IMDb and TMDB ids verified working (headed probe, S1E1 of a real
  // series); TMDB is the zero-risk default (vidup normalizes to TMDB internally).
  preferredId: 'tmdb',
  // Documented resume parameter (vidup docs): appended when the viewer has a
  // saved watch-progress position for the title/episode.
  startParam: 'startAt',
  testTitleId: 'tt1375666',
};

export const TWOEMBED_PROVIDER_CONFIG: ProviderConfig = {
  id: '2embed',
  enabled: true,
  displayName: '2Embed',
  baseUrl: 'https://www.2embed.cc',
  allowedDomains: ['2embed.cc'],
  // TMDB ids live-verified: IMDb ids currently redirect to a dead page.
  preferredId: 'tmdb',
  moviePathTemplate: '/embed/{id}',
  tvSeriesPathTemplate: '/embedtvfull/{id}',
  episodePathTemplate: '/embedtv/{id}?s={season}&e={episode}',
  shorthandEpisodeTemplate: '/embedtv/{id}?s={season}&e={episode}',
  defaultPriority: 300, // Server 2
  timeoutMs: 8000,
  enabledRegions: ['*'],
  consentRequired: true,
  testTitleId: 'tt1375666',
};

/**
 * Vidsrc/VSEmbed provider. The base domain lives here and ONLY here.
 */
export const VIDSRC_PROVIDER_CONFIG: ProviderConfig = {
  id: 'vidsrc',
  enabled: true,
  displayName: 'VSEmbed (Vidsrc)',
  // Single source of truth for the provider domain (Spec Section 9).
  baseUrl: 'https://vsembed.su',
  allowedDomains: ['vsembed.su'],
  moviePathTemplate: '/embed/movie/{id}',
  tvSeriesPathTemplate: '/embed/tv/{id}',
  episodePathTemplate: '/embed/tv/{id}/{season}/{episode}',
  shorthandEpisodeTemplate: '/embed/tv/{id}-{season}-{episode}',
  defaultPriority: 200, // Server 3
  timeoutMs: 8000,
  enabledRegions: ['*'],
  consentRequired: true,
  // Both IMDb and TMDB ids verified working in a headed probe; TMDB is the
  // zero-risk default.
  preferredId: 'tmdb',
  // Documented example IMDb id (Inception) for the admin preview/test action.
  testTitleId: 'tt1375666',
};

export const MOVSRC_PROVIDER_CONFIG: ProviderConfig = {
  id: 'vidsrc-mov',
  enabled: true,
  displayName: 'VidSrc.mov',
  baseUrl: 'https://vidsrc.mov',
  allowedDomains: ['vidsrc.mov'],
  moviePathTemplate: '/embed/movie/{id}',
  tvSeriesPathTemplate: '/embed/tv/{id}',
  episodePathTemplate: '/embed/tv/{id}/{season}/{episode}',
  shorthandEpisodeTemplate: '/embed/tv/{id}/{season}/{episode}',
  defaultPriority: 400, // Server 1
  timeoutMs: 8000,
  enabledRegions: ['*'],
  consentRequired: true,
  testTitleId: 'tt1375666',
};

/**
 * VidCore (Server 5). Documented on https://vidcore.org/#documentation:
 *   movie ............ moviePathTemplate     /embed/movie/{id}
 *   specific episode . episodePathTemplate   /embed/tv/{id}/{season}/{episode}
 *   whole series ..... tvSeriesPathTemplate  /embed/tv/{id}
 * TMDB ids are the documented key; optional params include autoplay, startAt,
 * theme, color, lang. VERIFICATION STATUS: pattern matches the docs; a health
 * probe confirms reachability (see /admin/providers).
 */
export const VIDCORE_PROVIDER_CONFIG: ProviderConfig = {
  id: 'vidcore',
  enabled: true,
  displayName: 'VidCore',
  baseUrl: 'https://vidcore.org',
  allowedDomains: ['vidcore.org'],
  moviePathTemplate: '/embed/movie/{id}',
  tvSeriesPathTemplate: '/embed/tv/{id}',
  episodePathTemplate: '/embed/tv/{id}/{season}/{episode}',
  shorthandEpisodeTemplate: '/embed/tv/{id}/{season}/{episode}',
  defaultPriority: 50, // Server 5
  timeoutMs: 8000,
  enabledRegions: ['*'],
  consentRequired: true,
  preferredId: 'tmdb',
  // Documented resume parameter.
  startParam: 'startAt',
  // TMDB id of Inception (the provider resolves TMDB ids).
  testTitleId: '27205',
};

/**
 * All configured providers, in registry-priority (public server-number) order.
 * The REGISTRY additionally merges any admin-configured `providers` rows from
 * the database, so an operator can add their own iframe providers from the
 * admin panel without code changes (see registry.ts / /admin/providers).
 */
export const PROVIDER_CONFIGS: readonly ProviderConfig[] = [
  VIDUP_PROVIDER_CONFIG,
  TWOEMBED_PROVIDER_CONFIG,
  VIDSRC_PROVIDER_CONFIG,
  MOVSRC_PROVIDER_CONFIG,
  VIDCORE_PROVIDER_CONFIG,
];

export function getProviderConfig(id: string): ProviderConfig | undefined {
  return PROVIDER_CONFIGS.find((c) => c.id === id);
}

export function listProviderConfigs(): readonly ProviderConfig[] {
  return PROVIDER_CONFIGS;
}
