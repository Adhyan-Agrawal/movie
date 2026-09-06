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
  /** Id used by the admin "test playback" / preview action. */
  testTitleId: string;
}

/**
 * Default Vidsrc/VSEmbed provider configuration. The base domain lives here and
 * ONLY here. Treat every field as admin-editable + audited in the future.
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
  defaultPriority: 100,
  timeoutMs: 8000,
  enabledRegions: ['*'],
  consentRequired: true,
  // Documented example IMDb id (Inception) for the admin preview/test action.
  testTitleId: 'tt1375666',
};

/** All configured providers (only Vidsrc for now). */
export const PROVIDER_CONFIGS: readonly ProviderConfig[] = [VIDSRC_PROVIDER_CONFIG];

export function getProviderConfig(id: string): ProviderConfig | undefined {
  return PROVIDER_CONFIGS.find((c) => c.id === id);
}

export function listProviderConfigs(): readonly ProviderConfig[] {
  return PROVIDER_CONFIGS;
}
