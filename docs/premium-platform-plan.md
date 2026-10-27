# Premium Platform Implementation Plan

## Goal

Evolve Lumora's existing web and Android apps into a coherent, branded streaming product. Combine Netflix-style discovery and playback with detailed Prime Video-style catalog browsing. Implement supported features rather than placeholder controls, preserve existing user data, and keep provider and billing secrets server-only.

## Delivery Rules

- Changes remain local. No commits, pushes, deployments, database migrations against live systems, or real payment operations without explicit authorization.
- Use bounded parallel ownership. Provider rate limits have already interrupted broad simultaneous audits, so implementation workers must have small, non-overlapping scopes.
- Read the exact Expo SDK 57 documentation before mobile edits, as required by `mobile/AGENTS.md`.
- Keep shared data contracts backward-compatible where existing web/mobile consumers or saved checkpoints require it.
- Use only authorized content, ad tags, tracking endpoints, subtitle services, and payment credentials.
- Preserve consent, authenticated account/profile isolation, RLS, permission checks, re-authentication, and audit logging.

## Phase 1: Audit And Baseline

- Record the web and mobile source/API maps, installed dependencies, existing tests, and build-tool availability.
- Run the existing web tests/typecheck and Android typecheck before broad edits; distinguish existing failures from new regressions.
- Identify the current VAST, subscription, catalog metadata, and admin-settings infrastructure before adding parallel implementations.
- Confirm real metadata available for genre, original language, country, catalog availability, and personalization.

## Phase 2: Playback Correctness

- Default untouched playback to Auto rather than silently restoring an old manual 4K preference.
- Rank Auto candidates by lowest verified startup latency, without preferring higher resolution when timings are tied or absent.
- Preserve explicit quality/audio/subtitle choices during playback and select the fastest candidate satisfying those choices.
- Start cold playback from a verified healthy candidate without waiting for every slow probe; refine selection from bounded discovery and cached measurements without repeated switching.
- Preserve content position, play/pause state, rate, volume, and selected tracks during internal changes and failure recovery.
- Request landscape after mobile web fullscreen succeeds; catch unsupported browser APIs and restore automatic orientation on exit.
- Lock Android fullscreen to landscape through supported Expo/native APIs and restore the previous orientation policy on exit, cancellation, and unmount.

## Phase 3: Premium Discovery

- Preserve hero, Continue Watching, personalized For You, watchlist, trending, new releases, and detailed title pages.
- Add clearly separated movie/series and genre navigation, with Action, Adventure, Comedy, Horror, Thriller, Romance, Science Fiction, Animation, Family, Documentary, and other supported genres.
- Add metadata-backed regional/language collections, including Hindi cinema/Bollywood, South Indian cinema, Korean and Japanese titles, and international cinema where actual data supports the classification.
- Do not label every Indian title as Bollywood or fabricate unsupported industry metadata.
- Add useful collection links, consistent listing filters/sorting, empty/degraded states, and shared discovery DTOs for Android.
- Keep public catalog caching separate from account history and avoid a new per-row database waterfall.

## Phase 4: Android Parity

- Share normalized direct-stream catalogs, verified latency ranking, subtitle catalogs, playback policy, and entitlements through server APIs.
- Provide quality, language, captions, speed, watched progress, seek controls, double-tap gestures, exact scoped resume, and conditional Up Next using installed native capabilities.
- Keep embedded-provider fallbacks separate from the unified direct source.
- Implement real native casting only where the installed/native build supports it; do not expose a nonfunctional Chromecast button in Expo Go.
- Preserve account/profile and guest history isolation during login changes, source switches, ad breaks, and navigation.

## Phase 5: Subscription Foundation

- Add admin-managed plans with stable identifiers, display names, price/currency/period metadata, enabled state, and only enforceable feature entitlements.
- Implement ad-free access as a server-derived entitlement with explicit status and expiry, not a client premium flag.
- Protect plan changes and administrative grants with permissions, validation, re-authentication for consequential actions, and audit records.
- Ensure ad-free users bypass VAST and existing banner/preroll placements on both platforms.
- Keep live checkout disabled until the operator selects a payment provider and configures its secrets and verified webhook handling.
- Require idempotent, authenticated webhook processing before a paid subscription activates or changes access.
- Use a compliant Google Play billing channel for digital subscriptions in a Play-distributed Android build; do not silently route Play purchases through an external checkout.

## Phase 6: VAST Mid-Roll And Admin Ads

- Add disabled-by-default, validated admin configuration for VAST tag, first break, repeat interval, per-session limits, and applicable skip/timeout policy.
- Implement bounded VAST linear-ad parsing/resolution, supported media selection, limited wrappers, and safe public HTTPS URL handling.
- Do not execute arbitrary VPAID JavaScript or accept private-network ad/tracking destinations.
- Schedule breaks from content playback, not wall time while paused, and prevent seeking or repeated events from triggering duplicate breaks.
- Pause content, isolate ad progress from watch checkpoints, and restore exact content position/state on completion, skip, error, timeout, or cancellation.
- Send only supported tracking events after applicable consent; do not fabricate impressions or double-fire completion.
- Add admin preview/validation, configuration health, enable/disable controls, and auditable failures rather than a cosmetic ads panel.

## Phase 7: Admin Login And Recovery

- The operator confirmed password-based authentication. Do not implement the proposed query-string bypass or a passwordless access mode.
- Keep authenticated admin permission checks intact.
- Send anonymous users through the existing sign-in flow with a safe return path instead of a confusing technical error.
- Show clear validation/recovery messages for failed login and unauthorized accounts without exposing secrets or stack traces.
- Audit consequential configuration changes and enforce actual fresh re-authentication where required.

## Phase 8: Motion And Operational Quality

- Add restrained card, shelf, menu, loading, and playback transitions consistent with Lumora's design system.
- Respect reduced-motion settings, keyboard focus, touch target sizes, screen-reader disclosure state, and viewport/fullscreen clipping.
- Avoid autoplaying heavy preview videos or blocking discovery on nonessential enrichment.
- Add useful admin loading/error states, input validation, permission-aware navigation, and configuration diagnostics.

## Ownership Boundaries

- Playback worker: web player, shared selection/orientation helpers, and focused player tests.
- Discovery worker: catalog metadata/contracts, homepage/listing/detail components, public query performance, and discovery tests.
- Android worker: mobile playback and orientation implementation after shared contracts are agreed.
- Commercial worker: subscription schema/entitlement services and protected plan administration; payment activation remains configuration-dependent.
- Advertising worker: VAST normalization, scheduling contracts, protected ad settings, and ad lifecycle tests.
- Coordinator: plan, API integration, admin-entry safety, cross-platform contract review, and final acceptance.
- Independent reviews must inspect stable completed scopes instead of editing the same files concurrently.

## Acceptance

- Auto selects a faster HD candidate over a slower 4K candidate; explicit 4K selects the fastest compatible 4K candidate.
- Reload, rewind-to-zero, account changes, failed sources, and ad transitions cannot lose or cross-contaminate resume points.
- Mobile web and Android fullscreen request landscape and clean up orientation on exit; unsupported platforms fail gracefully.
- Home collections contain real matching data, meaningful navigation, and no fabricated availability or industry labels.
- Ad-free entitlements are enforced on server and client; disabled or unconfigured ads make no third-party requests.
- VAST completion, skip, timeout, consent denial, and failed media restore content and fire tracking at most once.
- Plan/admin writes enforce current permissions and audit consequential changes; a query string cannot grant administrative access.
- Web tests, lint, typecheck, production build, mobile checks, and feasible desktop/mobile browser acceptance pass.
- Native hardware, emulator, Cast, billing-provider, ad-tag, and live-key limitations are reported explicitly rather than claimed as verified.

## Operator Decisions And Configuration

- Choose the paid web subscription provider and supply its server-side credentials before checkout is activated.
- Confirm Android distribution/billing channel before enabling in-app digital purchases.
- Password-based admin authentication is confirmed; no public query-string bypass will be added.
- Supply authorized VAST tags and approved tracking/media domains before ads are enabled.
- New SQL migration files may be prepared and tested locally; applying them to the live database requires explicit approval.
