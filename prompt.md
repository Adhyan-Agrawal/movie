# LUMORA OTT STREAMING PLATFORM
## Master Product, Design, Engineering, and Delivery Specification

**Status:** Baseline master specification  
**Audience:** Product, design, engineering, QA, DevOps, security, content operations, and Claude Code  
**Stack:** Next.js App Router, React, TypeScript, Supabase, PostgreSQL

> Build a production-grade OTT platform, not a static demo. Use only content, embeds, URLs, and provider credentials the operator is authorized to use. Do not bypass paywalls, geo-blocks, anti-bot systems, DRM, or provider restrictions. Treat this document as the implementation source of truth.

---

## 0. EXECUTION CONTRACT

Act as a staff full-stack engineer, product designer, accessibility specialist, security engineer, and QA lead. Before coding, inspect the repository, package manager, routes, environment files, and git status. Create ADRs for unspecified decisions. Establish Supabase migrations, RLS, seed data, typed environment validation, CI checks, and an accessible design system. Build vertical slices and keep the application runnable after each slice.

Every feature is done only when it has loading, empty, error, unauthorized, offline, and destructive-confirmation states; server validation; authorization; RLS; tests; documentation; and responsive keyboard-accessible UI. Never hardcode secrets. Never claim a provider or integration works without a test or documented manual verification.

## 1. VISION AND PRINCIPLES

Lumora is a calm, premium movie and television service combining editorial discovery, personal profiles, seamless resume watching, and a professional content operations console. The product should feel crafted like Apple TV, Netflix, Prime Video, Linear, and Stripe—not like a generic AI-generated Tailwind site.

Principles: content first; fast to intent; personal by default; operator controlled; transparent and trustworthy; deliberate motion; resilient degradation; privacy and accessibility as release requirements.

Non-goals for v1: proprietary transcoding, DRM, offline downloads, payments, and any mechanism that circumvents provider restrictions. Keep interfaces extensible for later licensed features.

## 2. USERS AND ROLES

Visitor: browse, search, view details, consent, and watch only when guest viewing is enabled. Viewer: profiles, watchlists, ratings, history, resume progress, notifications, devices, and preferences. Content editor: catalog creation, imports, drafts, previews, schedules, publication, and organization. Ad manager: placements, campaigns, caps, consent, and reports. Support agent: safe playback/account diagnostics. Administrator: settings, users, integrations, audit, health, and roles. Owner: full access with re-authentication for sensitive actions.

## 3. INFORMATION ARCHITECTURE

Public: `/`, `/browse`, `/movies`, `/tv`, `/genre/[slug]`, `/collection/[slug]`, `/title/[type]/[id]`, `/search`, `/watch/[type]/[id]`, `/person/[id]`, auth routes, and legal routes. Authenticated: `/account`, `/account/profiles`, `/account/watchlist`, `/account/history`, `/account/settings`, `/account/devices`, `/account/notifications`. Admin: `/admin`, `/admin/catalog/titles`, `/admin/catalog/episodes`, `/admin/catalog/people`, `/admin/catalog/genres`, `/admin/catalog/collections`, `/admin/providers`, `/admin/ads`, `/admin/users`, `/admin/roles`, `/admin/analytics`, `/admin/email`, `/admin/settings`, `/admin/audit`, `/admin/health`, and `/admin/imports`.

Desktop uses a compact expandable rail; mobile uses bottom navigation and contextual sheets. Admin navigation is separate. Every route needs title metadata, canonical policy, loading/error/not-found states, and correct indexing policy.

## 4. PRODUCT REQUIREMENTS

### Home and browse

Hero content is manually ordered or algorithmic and includes backdrop/poster fallback, title, year, runtime, maturity, genres, synopsis, play, trailer, watchlist, and availability. Rows include continue watching, trending, popular, recently added, editorial collections, genres, and personalized recommendations. Browse supports type, genre, year, rating, runtime, language, availability, and sort filters persisted in URL parameters, with chips, result counts, reset, pagination, and no-result guidance.

### Search

Debounced, cancellable search with suggestions, recent searches, trending terms, typo tolerance, and grouped title/person/collection results. Do not send raw keystrokes to third parties unless documented and consented. Use indexed PostgreSQL search first.

### Search-to-title and automatic Vidsrc resolution

When a viewer searches for a title that is not yet cached in Lumora, the server may query TMDB using the configured server-side TMDB integration. The result must be normalized, validated, cached, and associated with its numeric TMDB ID and, when available, IMDb ID. The UI then displays the fetched title using the same premium title-card and title-detail experience as an existing catalog item.

When the viewer opens the fetched title, the playback service must automatically resolve an authorized Vidsrc/VSEmbed player URL using the title’s TMDB or IMDb identifier and the documented movie or TV route. For television, support the whole-series player and specific season/episode resolution. The title page must show a loading state while metadata and playback availability are resolved, then show Play, Watchlist, metadata, artwork, and provider availability. The viewer must not need an administrator to manually paste a URL for ordinary TMDB-backed discovery.

The flow is:

```text
Viewer enters query
  -> search local cache
  -> if absent/stale, query TMDB server-side
  -> normalize and cache title metadata
  -> resolve TMDB/IMDb identifier to Vidsrc/VSEmbed URL
  -> validate provider domain and policy
  -> show title detail
  -> on intentional play, load isolated provider player
  -> record Lumora playback session and progress where supported
```

Cache TMDB results with a configurable freshness period and deduplicate simultaneous requests. Respect TMDB rate limits, attribution, provider terms, consent, region policy, and rights review. Do not expose TMDB or provider secrets in the browser. If TMDB succeeds but Vidsrc is unavailable, show the metadata and a clear “Playback currently unavailable” state with retry and alternate authorized-source actions. If the title ID is invalid or ambiguous, show a recoverable error rather than constructing an unsafe URL. Add tests for cache hit, cache miss, stale refresh, movie resolution, TV-series resolution, episode resolution, provider failure, disabled guest viewing, and rate limiting.

### Title detail

Show poster/backdrop, title, metadata, synopsis, credits, trailers, seasons/episodes, similar titles, ratings, provider/server health, progress, watchlist state, share link, SEO fields, and clear unavailable/consent-required states. Never present a broken iframe as the primary experience.

### Playback

Player page prioritizes video, controls, source/server, quality, subtitles, audio tracks, speed where supported, skip intro/recap, next episode, report issue, and back navigation. Persist progress periodically and on lifecycle events with throttling and conflict handling. Support guest persistence in a signed local/session context and explicit merge into an account.

### Profiles and account

Multiple profiles, avatars, language, maturity level, autoplay, captions, reduced motion, profile PIN interface, watchlist, history, device sessions, notification preferences, data export, and deletion. Revoke sessions and require re-auth for sensitive operations.

## 5. UI/UX DESIGN BIBLE

Use a dark cinematic base, restrained translucent surfaces, thin borders, soft depth, and gradients only for legibility over artwork. Avoid excessive glow, pills, generic cards, and unmodified shadcn dashboard styling. Use licensed display/UI fonts, 4px spacing tokens, small/medium/large semantic radii, high-contrast primary text, muted secondary text, and explicit success/warning/danger/info colors.

Components: AppShell, rail, mobile nav, top bar, command search, hero, media card/row, artwork, metadata line, rating/maturity badges, progress, play/watchlist buttons, provider badge, filters, tabs, season/episode list, player shell/controls/menus, recovery panel, toast/dialog/drawer, data table, bulk actions, forms, URL input, code editor, audit timeline, charts, skeleton, empty/error states.

Motion is short and purposeful. Respect `prefers-reduced-motion`; disable parallax and nonessential autoplay. Target WCAG 2.2 AA: landmarks, semantic headings, visible focus, logical tab order, 44px targets, contrast, screen-reader names, `aria-live`, captions metadata, keyboard player controls, zoom, high contrast, and reduced-motion verification.

## 6. ENGINEERING ARCHITECTURE

Required stack: Next.js App Router, React, strict TypeScript, Tailwind token layer, Radix primitives as useful, TanStack Query, Zustand only for local UI/player state, React Hook Form, Zod, Supabase Auth/Postgres/Storage/Realtime, Vitest, Testing Library, Playwright, and accessibility assertions.

```text
src/app/                 # routes, layouts, loading, error, not-found
src/components/          # reusable UI
src/features/            # catalog, player, account, admin, ads, analytics
src/lib/supabase/        # browser/server clients
src/lib/providers/       # adapters and normalization
src/lib/validation/      # Zod schemas
src/lib/permissions/     # authorization
src/server/              # services and repositories
supabase/migrations/     # schema and RLS
supabase/functions/      # jobs and webhooks
tests/unit integration e2e/
docs/adr/
```

Server components are default. Route handlers call services; services call repositories; repositories own table details. Client DTOs never contain service-role keys or raw secrets. Type and validate public/private environment variables at startup.

## 7. SUPABASE DATABASE

Use UUID keys, UTC timestamps, foreign keys, checks, unique constraints, soft deletion where auditability matters, and query-driven indexes. Enable RLS on every application table.

Identity/RBAC: `accounts`, `profiles`, `roles`, `permissions`, `role_permissions`, `account_members`, `sessions`.

Catalog: `titles` (movie/tv, TMDB ID, slug, names, synopsis, release, runtime, maturity, status, visibility, language, artwork, trailer, featured, editorial score, publication, audit fields), `seasons`, `episodes`, `people`, `title_people`, `genres`, `title_genres`, `collections`, `collection_items`, `tags`, `title_tags`.

Playback: `providers`, `media_sources`, `subtitle_tracks`, `audio_tracks`, `playback_sessions`, `watch_progress`. A source stores kind, URL/reference, label, language, quality, priority, default, enabled, consent flag, geo policy, safe headers metadata, health, timestamps, and creator. Progress has a unique profile/title/episode key.

Engagement: `watchlists`, `watchlist_items`, `ratings`, `reviews`, `comments`, `recent_searches`, `notifications`.

Operations: `site_settings`, `feature_flags`, append-only `audit_logs`, `imports`, idempotent `webhook_events`, and `health_checks`.

Advertising: `ad_providers`, `ad_placements`, `ad_campaigns`, `ad_creatives`, `ad_events`.

RLS: public users read only published, public, released, region-allowed catalog; viewers read/write only their own profile activity; editors mutate only permissioned content; sanitized active ads are public but raw configuration is server-only; audit logs are admin-read and append-only; service role is server/jobs only. Use database functions for effective permissions, publication eligibility, and entitlements. Include tests for anonymous, viewer, editor, admin, and owner boundaries.

## 8. AUTHENTICATION AND RBAC

Support email/password or magic link, Google, GitHub, verification, reset, optional MFA, secure cookies, session revocation, devices, rate limits, and account deletion. Guest browsing and guest viewing are separate settings. Guest progress is never silently attached to another account.

Permissions include `catalog.read/create/publish/delete`, `provider.manage`, `ads.manage`, `email.manage`, `users.read/suspend`, `roles.manage`, `analytics.read`, `settings.manage`, `audit.read`, and `health.read`. Re-authentication plus audit event for role changes, secret rotation, bulk delete, account deletion, and provider changes.

## 9. PLAYER AND PROVIDER SYSTEM

Implement a normalized adapter:

```ts
type PlaybackRequest = { titleId: string; episodeId?: string; profileId?: string };
type PlaybackSource = { id: string; label: string; kind: 'mp4'|'hls'|'dash'|'youtube'|'iframe'|'embed'|'custom'; url?: string; manifestUrl?: string; qualities?: Quality[]; subtitles?: Track[]; capabilities: Capabilities };
interface ProviderAdapter { resolve(r: PlaybackRequest): Promise<PlaybackSource[]>; healthCheck(): Promise<HealthResult>; normalizeError(e: unknown): PlaybackError }
```

Support native MP4, HLS/M3U8, DASH, official YouTube/Vimeo/Dailymotion embeds, authorized VSEmbed-style embeds, allowlisted generic iframe/embed, and versioned custom adapters. Use official contracts, required branding/origin settings, sandbox and CSP. Never accept arbitrary editor HTML/JS; if enterprise custom code is later approved, isolate it on a separate origin with strict CSP and no application cookies.

Source selection considers priority, health, language, quality, region, and preference. Use timeouts, circuit breakers, limited retries, manual source selection, and useful error recovery. Player states: idle, loading, ready, playing, paused, seeking, buffering, ended, blocked, consent-required, unsupported, and provider/network error. Events: attempt, success, play, pause, seek, quality, caption/audio, heartbeat, completion, exit, and error; redact tokens and full private URLs.

### Vidsrc/VSEmbed API integration

The platform must explicitly support the Vidsrc/VSEmbed embed API documented at [https://vsembed.su/vidsrc/docs/](https://vsembed.su/vidsrc/docs/). Treat this as a provider adapter, not as a generic iframe pasted into arbitrary pages.

The adapter must support the documented movie and TV player URL patterns, including IMDB IDs beginning with `tt` and numeric TMDB IDs. It must support a complete TV series URL with the built-in season/episode picker, a specific season and episode route, and the documented shorthand season-episode route. The exact base domain and path must be stored in provider configuration so domains can be changed through an administrator-controlled, audited setting when the provider changes its infrastructure.

Required admin fields: enabled, display name, base URL, allowed domains, movie path template, TV-series path template, specific episode path template, shorthand episode template, default provider priority, timeout, enabled regions, consent requirement, and test title ID. Do not hardcode a production provider domain in multiple components.

The Vidsrc adapter must expose the provider’s documented capabilities to the player UI: responsive iframe playback, fullscreen, quality selection including Auto and available resolutions, multi-language subtitles and caption styling where supported, TV season/episode selection, and provider-side resume behavior. Lumora must still maintain its own watch-progress records because iframe providers may not expose reliable cross-device telemetry or completion events.

The integration must include: origin allowlisting, `frame-src` CSP configuration, sandbox attributes appropriate to the provider contract, `referrerPolicy`, lazy loading only when it does not delay intentional playback, explicit external-provider labeling, timeout and unavailable states, manual retry, alternate authorized source selection, and a “report playback issue” action. Never scrape the iframe, inject scripts into it, attempt to bypass provider restrictions, or claim native quality/subtitle analytics when the embed API does not expose those events.

The provider repository must generate and validate URLs server-side, return a sanitized iframe URL to the client, and record only the provider ID, title/episode ID, selected source metadata, and safe playback diagnostics. Never log query strings or tokens that may contain sensitive data. Add contract tests for movie, whole-series, specific-episode, shorthand-episode, invalid-ID, disabled-provider, and provider-unavailable cases. Add an admin preview/test action that verifies URL construction and loads the embed only in an isolated preview surface.

The provider documentation states that no API key is required for the documented embed use case. Do not assume that means unlimited commercial use, guaranteed availability, or permission to redistribute content; the operator must review the provider’s current terms, rights status, and applicable law before production publication.

## 10. ADMIN CMS

The console controls the platform without hiding important behavior in source code. Every setting shows scope, default, validation, affected surfaces, editor, timestamp, and rollback.

Dashboard: users, guests, online/active streams, catalog counts, views, watch hours, revenue-ready metrics, ad events, provider health, database/storage/API health, imports, email delivery, trends, top titles, watchlists, and daily/weekly/monthly charts with timezone, filters, export, and definitions.

Catalog: create/edit/duplicate/archive/restore, bulk upload/edit, draft/private/publish/schedule, feature/pin, reorder, genres/collections/tags/studios/actors/directors, editorial labels, artwork variants, subtitles/audio, SEO, canonical slug, age rating, visibility, geo restrictions, localization, and preview.

TMDB: server-side search/import, field-level conflict preview, manual override protection, caching, rate-limit handling, attribution, sync timestamps, and no silent overwrite of editorial changes.

Sources: unlimited sources per title/episode, MP4/M3U8/HLS/DASH, authorized YouTube/Vimeo/Dailymotion/VSEmbed/embed/custom provider references, quality/language/priority/default, captions/audio, schedule, health, consent, region, test playback, masking, allowlists, and audit.

Settings: brand, logo, favicon, color, typography, navigation, home rows, hero behavior, locale, timezone, cookie/privacy/legal links, maintenance mode, registration, verification, guest browse/watch, profile count, maturity, ratings, reviews, comments, sharing, autoplay, resume threshold/interval, SEO, robots/sitemap, social cards, region policy, feature flags, and error pages.

Users: search, safe metadata, suspend, revoke sessions, verify/reset, role management, support-safe diagnostics, export/delete, and operator notes. Imports: CSV/JSON, preview, mapping, validation, dry run, idempotency, resumable batches, duplicate policy, error report, and publication policy. Audit: immutable events, before/after diffs, actor, target, reason, outcome, filters, and export.

## 11. ADVERTISING

Create adapters for pre-roll, mid-roll, post-roll, display, native, banner, and house promotions. Adsterra must use its current official integration and terms; keep an AdSense-ready interface without assuming approval. Controls: provider, placement, format, device targeting, schedule, consent, frequency cap, cooldown, skip rules where permitted, fallback house ad, test mode, impression/click events, revenue metadata, and global/placement kill switch. Sanitize or isolate third-party creative, apply CSP, label ads, and never personalize before required consent.

## 12. SMTP AND EMAIL

Transport abstraction for SMTP and future transactional providers. Templates: verification, welcome, reset, sign-in alert, device, availability, episode, moderation, import, provider degradation, and invitation. Admin controls: host/port/TLS, sender/reply-to, branding, safe variables, preview, test send, category toggles, retries, suppression, unsubscribe, and logs. Queue sends, use idempotency and exponential retry, escape user values, provide text alternatives, and protect secrets.

## 13. ANALYTICS, SEARCH, RECOMMENDATIONS

Version event contracts for impressions, searches, title opens, play attempts/success, heartbeats, completion, watchlist, rating, error, ad, email, and admin actions. Consent-aware, retention-limited, exportable, deletable, aggregated where possible. Dashboards cover product, content, playback, advertising, and operations.

PostgreSQL full-text/trigram search indexes titles, alternate names, people, genres, tags, collections; rank exact/prefix/popularity/editorial/availability. Recommendation v1 is transparent rules: continue watching, genre, people, similar metadata, popularity, and editorial rows. Store a human-readable recommendation reason.

## 14. API CONTRACT

Use typed, versioned APIs with `{ data, error, requestId }`, input validation, permission checks, idempotency, rate limits, pagination, caching, and structured logs. Implement catalog home/search/title; playback session/heartbeat/report; profile watchlist; account preferences; admin imports/publish/settings/audit; and signed, replay-protected provider webhooks. Document schemas, auth, errors, and examples.

## 15. SECURITY, PRIVACY, RELIABILITY

Threat model XSS, CSRF, SSRF from imported URLs, open redirects, iframe abuse, privilege escalation, IDOR, token leakage, replayed webhooks, malicious uploads, third-party scripts, and abuse. Use secure cookies, strict CSP, frame-ancestors, origin allowlists, scheme/host validation, SSRF-safe checks, request/rate limits, schema validation, output encoding, dependency/secret scans, security headers, safe errors, encryption for sensitive fields, and least privilege.

Provide consent banner, granular ad/analytics consent, privacy/terms/cookies pages, export/delete workflows, retention settings, guest cleanup, and data-subject request documentation. Health checks cover database, auth, storage, TMDB, email, ads, and playback. Define RPO/RTO with the operator; rehearse backup restore and graceful degradation.

## 16. PERFORMANCE, SEO, ACCESSIBILITY

Server-render catalog and metadata, optimize responsive artwork, lazy-load below fold, reserve aspect ratios, cache safely, index queries, paginate, analyze bundles, and test mid-tier mobile and slow networks. Implement per-title metadata, canonical URLs, Open Graph, JSON-LD where appropriate, sitemap for published content, robots controls, clean slugs, and noindex for private/admin/player states as appropriate.

## 17. TESTING

Unit test provider normalization/source selection, progress merge, permissions, settings, ad targeting, consent, email rendering, slugs, recommendations, and analytics redaction. Integration test repositories/RLS, auth, publishing, imports, webhooks, queues, and provider health. E2E test guest policy, signup, profiles, search, details, playback/resume, watchlist, episodes, settings, admin publish, failover, ad kill switch, SMTP test, and denial paths. Gate releases on typecheck, lint, migrations, production build, accessibility, secret scan, browser coverage (Chromium/Firefox/WebKit), mobile, keyboard-only, reduced motion, offline transition, and failure recovery.

## 18. DEPLOYMENT AND OPERATIONS

Document local setup, Supabase setup/migrations/seed, preview and production deployment, domains, SMTP, TMDB, provider allowlists, ads, backups, monitoring, and rollback. Separate dev/staging/prod projects. Apply migrations through CI with production approval. Smoke-test after deploy. Runbooks cover database/auth/provider/email/ad outage, leaked secret, abuse, bad import, accidental publication, artwork failure, and rollback.

## 19. PHASED ROADMAP

Phase 0 foundation: repository audit, ADRs, tokens, shell, env validation, Supabase, migrations, RLS, seed, CI, error boundaries, logging, legal placeholders. Phase 1 identity/catalog: auth, guest policies, profiles, TMDB, catalog, browse/search/detail, accessibility. Phase 2 playback: adapters, MP4/HLS, player, progress, history, episodes, health, captions, telemetry. Phase 3 engagement: watchlists, ratings, moderation, notifications, recommendations, sharing, devices, guest merge. Phase 4 CMS: dashboard, CRUD, imports, drafts, schedules, sources, health, audit, users, settings, flags, rollback. Phase 5 commercial: ads, consent, campaigns, analytics, SMTP queue/templates, privacy/export. Phase 6 launch: security, load, accessibility, SEO, restore/failure drills, observability, staged release. Future: entitlements, subscriptions, DRM, licensed downloads, live channels, multi-region, advanced personalization, casting, TV/native apps, and two-person approvals.

## 20. RELEASE CHECKLIST

- [ ] Secrets use deployment management and are absent from client bundles.
- [ ] Migrations, RLS, permissions, and backup restore pass.
- [ ] Authorized sample content and provider attribution are correct.
- [ ] Guest/viewer/editor/admin/owner boundaries are verified.
- [ ] Playback adapters have timeout, failure, fallback, and unavailable states.
- [ ] URLs, iframe origins, uploads, webhooks, and custom fields are validated.
- [ ] Consent, ad labels, caps, and kill switches work.
- [ ] Verification/reset emails and suppression work.
- [ ] Resume works across refresh and sessions.
- [ ] Accessibility, performance, SEO, responsive, browser, and security checks pass.
- [ ] Monitoring, audit, incident runbooks, privacy/legal content, and rollback are ready.

## FINAL DIRECTIVE

Implement this as one coherent product with typed contracts, small composable modules, explicit failures, reversible operations, and production documentation. When ambiguous, choose the safest reversible behavior, record an ADR, and expose it as an admin setting only when that does not weaken a security boundary.
