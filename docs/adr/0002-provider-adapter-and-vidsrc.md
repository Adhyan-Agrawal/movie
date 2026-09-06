# ADR 0002 — Provider adapter abstraction and Vidsrc/VSEmbed integration

- Status: Accepted
- Date: 2026-09-04
- Deciders: Engineering, Security
- Context refs: prompt.md Sections 9, 15; provider docs https://vsembed.su/vidsrc/docs/

## Context

Playback sources are heterogeneous: native MP4, HLS/DASH manifests, official
YouTube/Vimeo/Dailymotion embeds, VSEmbed-style embeds, allowlisted generic
iframes, and future custom adapters. We need one normalized contract for the
player, and we must integrate the Vidsrc/VSEmbed embed API **as a first-class
provider adapter**, not as an arbitrary iframe pasted into pages.

Constraints from the spec:
- The exact base domain and URL path templates must be **configuration**, not
  hardcoded, so an admin can rotate them (audited) when the provider changes
  infrastructure.
- Do not hardcode a production provider domain in multiple components.
- Never scrape the iframe, inject scripts, or attempt to bypass provider
  restrictions, paywalls, geo-blocks, or DRM.
- URLs are built and validated **server-side**; the client receives only a
  sanitized iframe URL. Never log query strings or tokens.

## Decision

**Normalized adapter interface.** Every provider implements:

```ts
interface ProviderAdapter {
  resolve(r: PlaybackRequest): Promise<PlaybackSource[]>;
  healthCheck(): Promise<HealthResult>;
  normalizeError(e: unknown): PlaybackError;
}
```

Source selection considers priority, health, language, quality, region, and
user preference, with timeouts, circuit breakers, limited retries, manual source
selection, and explicit recovery states.

**Config-driven provider base domain.** Provider configuration lives in the
`providers` table (migration 0003): `base_url`, `allowed_domains[]`,
`movie_path_template`, `series_path_template`, `episode_path_template`,
`shorthand_episode_template`, `priority`, `timeout_ms`, `enabled_regions[]`,
`consent_required`, and `test_title_id`. The Vidsrc adapter reads these; nothing
hardcodes a domain. Changing `base_url` is an admin-controlled, audited setting
(the change is a sensitive `provider.change` action — see ADR 0003).

**Vidsrc/VSEmbed adapter** supports the documented movie and TV URL patterns
(numeric TMDB IDs and `tt…` IMDb IDs), the whole-series player with built-in
season/episode picker, specific season/episode routes, and the shorthand
season-episode route. It exposes the provider's documented capabilities
(responsive iframe, fullscreen, quality incl. Auto, multi-language subtitles
where supported, season/episode selection, provider-side resume) to the player
UI — and only those. We do not claim native quality/subtitle analytics the embed
API does not emit.

**Security posture (Section 15).**
- URLs are generated and validated on the server; the repository returns a
  sanitized iframe URL plus safe metadata only.
- `isAllowedHost(url, allowedDomains)` (in `src/lib/validation/source.ts`)
  enforces https-only, rejects embedded credentials and private/loopback/
  link-local hosts (SSRF), and requires the host to match the provider
  allowlist. An empty allowlist denies everything.
- The embed is rendered in an isolated surface with `frame-src`/`frame-ancestors`
  CSP, appropriate `sandbox` attributes per the provider contract, and
  `referrerPolicy`. Lazy loading is used only when it does not delay intentional
  playback.
- Ads/embeds are explicitly labeled as external. A "report playback issue"
  action and alternate authorized-source selection are always available.
- We record only provider ID, title/episode ID, selected source metadata, and
  safe diagnostics — never query strings or tokens.

**Lumora keeps its own watch-progress** because iframe providers may not expose
reliable cross-device telemetry or completion events.

**No arbitrary editor HTML/JS.** Custom-code providers, if ever approved, are
isolated on a separate origin with strict CSP and no application cookies.

## Consequences

- One player UI over many source types; providers are swappable and versioned.
- Domain rotation is an operational setting, not a code change/redeploy.
- Server-side URL construction plus SSRF-safe host checks close the main iframe/
  import attack surface.
- The operator remains responsible for reviewing the provider's current terms,
  rights status, and applicable law before production publication; "no API key
  required" is not permission to redistribute content.

## Alternatives considered

- **Hardcoded Vidsrc domain + string-built iframe URLs in components** —
  rejected: brittle on provider changes, duplicated, and unsafe.
- **Client-side URL construction** — rejected: leaks provider details/tokens and
  removes the server validation checkpoint.
