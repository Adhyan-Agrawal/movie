# Lumora

A cinematic OTT platform with editorial discovery and direct playback. The active
repository is being prepared for Netlify; existing Cloudflare hosting is unchanged.
See `CONTEXT.md` for verified results, unfinished features, and the local-only scope.

> **Authorized use only.** Use only content, embeds, URLs, and provider
> credentials the operator is authorized to use. Do **not** bypass paywalls,
> geo-blocks, anti-bot systems, DRM, or provider restrictions. These are hard
> product constraints, not preferences.

## Stack

- **Next.js 15.5.28 App Router** (React, strict TypeScript): server components by
  default, route-level loading/error/not-found states, Node.js 22.12+.
- **Netlify** automatic OpenNext adapter for Next.js SSR, route handlers and Server Actions.
  The guarded Cloudflare path remains available separately as a legacy, manual-only option.
- **Tailwind** token layer for a dark, cinematic design system.
- **Supabase** integration and RLS migrations for account/data features.
  Their presence is not evidence that a backend is configured or operational.
- **Zod** for typed environment + input validation.
- **Vitest / Testing Library / Playwright** for unit, integration, and e2e tests
  with accessibility assertions.

## Scripts

```bash
npm run dev         # dev server at http://localhost:3000
npm run build       # production build
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint (next lint)
npm run test        # vitest run
```

## Netlify hosting

Work in `D:\movie platform`. Current preparation is **local repository changes
only**: no Git upload, deployment, account operations, secret transfer, provisioning
or resource deletion. The immutable `D:\movie platform-cloudflare-backup` and
canonical Android app are not active migration folders.

`netlify.toml` uses the repository root, `npm run build`, publish directory `.next`,
Node 22 (satisfying the package's Node 22.12+ minimum), and opt-in
`NETLIFY_NEXT_SKEW_PROTECTION=true`. Keep devDependencies available during install.
Netlify automatically supplies its current Next.js OpenNext adapter; do not pin
`@netlify/plugin-nextjs`, publish `.open-next`, enable static export, or add a SPA
catch-all rewrite. Server Components, route handlers and Server Actions need the
generated server function, not a static-directory upload.

When deployment is separately authorized, configure the following values in the
Netlify UI for the intended deploy context. Values in `[build.environment]` are
not a substitute for Functions-scoped application variables. No actual site URL
or private values are stored in the checked-in template.

| Settings | Netlify scope | Requirement |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_URL` | Builds + Functions | Set the operator's verified canonical HTTPS origin. Do not guess a Netlify domain or derive it from request headers. Public values are compiled into client assets; changing them requires a new build. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Builds + Functions | Optional matched pair from one project. Leave both unset for unavailable account functionality. Never use a private/service-role key here. |
| `TMDB_API_KEY`, `TMDB_API_BASE_URL` | Functions only | Authorized catalogue credentials and the documented API base. The default base is `https://api.themoviedb.org/3`. |
| `VIDNEST_API_SECRET` | Functions only | Stable random 32+ character private playback-capability key, not an upstream provider credential. |
| `WATCH_PARTY_WORKER_URL` | Builds + Functions | Optional HTTPS origin of the existing separate room service, required in the generated WebSocket CSP as well as the ticket handler. |
| `WATCH_PARTY_SECRET` | Functions only | Optional matching 32+ character room-service key. Leave both party settings unset to preserve its unavailable state. |
| `SUPABASE_SERVICE_ROLE_KEY`, `WYZIE_API_KEY`, `WYZIE_SUBTITLE_TOKEN_SECRET`, `ADSTERRA_KEY_*` | Functions only | Configure only the corresponding authorized optional features. Keep all private settings out of `NEXT_PUBLIC_*`. |

Do not pass Cloudflare account credentials, `NEXTJS_ENV`, or legacy `.dev.vars`
into the Netlify build. No migration copies current secrets or activates services.
Authentication still requires confirmation emails, a permitted callback URL and
the correct schema/RLS policies. Preview deployments must have deliberately scoped
configuration; they must not silently reuse a production canonical URL or secrets.

Watch Party still uses a **separate durable WebSocket service**. Hosting the web
app on Netlify does not deploy that service or change its origin allowlist. The
service must separately allow the verified web origin under future authorization.
Do not replace durable rooms with process memory or assume Netlify Functions can
hold the room sockets. Likewise, media streaming size/duration limits, cold starts,
custom-fetch behavior and third-party availability require hosted acceptance;
a local Next build cannot certify sustained playback on Netlify. Netlify currently
documents 60-second synchronous/streaming execution, 20 MB streamed responses and
6 MB buffered payloads. Validate actual media delivery against the applicable
[Functions limits](https://docs.netlify.com/build/functions/configuration/) before
claiming hosted playback support.

The rate-limited resolver/subtitle routes require Netlify's trusted
`x-nf-client-connection-ip` header and platform-provided runtime `SITE_ID`.
Unidentified production work returns a private HTTP 503 rather than trusting
forwarded headers. Do not fake that platform metadata in production. An extra
proxy in front of Netlify may share one connection IP across users, and the
bounded in-process counters are not a distributed abuse-prevention service.

Skew protection covers supported Next.js navigation/Server Action requests, not
arbitrary client `fetch` calls automatically. It is not a fix for the historical
mobile hydration issue. Artwork remains direct-origin (`images.unoptimized=true`).

Official references: [Next.js on Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/)
and [Functions environment variables](https://docs.netlify.com/build/functions/environment-variables/).

## Legacy Cloudflare path

The existing Cloudflare dependencies, configuration, commands and **manual-only**
workflow are retained for their regression coverage and separately authorized
legacy work. They are not part of `npm run build` or the Netlify build path.
The migrated web runtime now targets Node; it is not certified for a future
Cloudflare release without separate runtime adaptation and validation. The old
Cloudflare runtime fixtures are not Netlify acceptance tests. Do not run
account/deployment commands during local Netlify preparation.

```bash
npm run cf:build           # sanitized OpenNext Worker build
npm run cf:dry-run:built   # validate an existing Worker build without publishing
npm run cf:preview         # local preview
```

The guarded `cf:deploy` and `cf:deploy:built` commands and the manual-only
Cloudflare workflow require a separately and explicitly requested legacy release.
Do not confuse `npm run build` (the Next.js build) with the complete Worker
artifact generated by `cf:build`.

Use a verified HTTPS app origin and keep public build settings consistent with
runtime settings. Server credentials and signing secrets must never enter
`NEXT_PUBLIC_*`/`EXPO_PUBLIC_*` values or committed environment files. The
Cloudflare build preserves exactly four public environment exports: app name, app URL,
Supabase URL and Supabase anon key. The separately allowlisted, nonsecret
`WATCH_PARTY_WORKER_URL` is also a build input for the WebSocket CSP, but is not
added to that public environment module. No private signing/service keys are
passed into the build.

The deployment guard and manual CI share the same value-redacted validator.
It requires public HTTPS origins, paired Supabase URL/anon settings, paired
Watch Party URL/secret settings, 32+ character playback/party signing secrets,
and production `NEXTJS_ENV`. Auth-only Supabase does **not** require a
service-role key. Known private Supabase keys in the public anon field are
rejected. This is configuration validation, not verification of credentials,
DNS, backend health, database policies or email delivery.

Configuration-changing releases compare all four built public fields against
the runtime bindings and require the party WebSocket origin in the bundled
page CSP. A mismatch fails before authentication/upload; rebuild with the
intended public/CSP inputs rather than editing generated files. Artifact-only
`cf:dry-run:built` does not reload local dotenv files and does not validate
remote runtime configuration. `cf:deploy:validate` still invokes Cloudflare
authentication, so it is not an offline readiness check.

For an explicitly authorized code-only release,
`node scripts/deploy-cloudflare.mjs --skip-build --preserve-runtime` keeps
existing runtime values, requires an existing sanitized artifact and rejects
`--secrets-file`. It cannot activate login/party or prove the preserved runtime
matches the build; that match needs separate authorized verification. A normal
configuration-changing deploy stages the entire allowed runtime snapshot,
including empty optional bindings, not a partial merge of previous settings.

`D:\movie platform-cloudflare-backup` is the verified, immutable snapshot made
before the original migration. It is not an active work folder. Future API,
Watch Party, and migration sources are not automatically deployed by the web
application or by merely committing those files.

## Feature configuration

Local file presence is not production readiness. The last published artifact
recorded in `CONTEXT.md` has empty public Supabase values. Setting runtime
secrets alone cannot change its compiled auth configuration; a later authorized
build and release must carry the intended public values.

| Feature | Exact operator configuration required |
| --- | --- |
| Base web deployment | `NEXT_PUBLIC_APP_NAME`, canonical public HTTPS `NEXT_PUBLIC_APP_URL`, `TMDB_API_KEY`, `TMDB_API_BASE_URL` (normally `https://api.themoviedb.org/3`), and private random `VIDNEST_API_SECRET` of at least 32 characters. `NEXTJS_ENV=production` is specific to the legacy Cloudflare path, not Netlify. |
| Supabase login | Matching `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` at build and runtime. Enable email/password auth with email confirmation; configure working Supabase confirmation-email delivery, the same canonical Site URL, and the generated `/auth/callback?next=<internal-path>` redirect. Account/profile data also needs the reviewed schema and RLS policies applied in that project under separate authorization. |
| Privileged Supabase operations | Optional server-only `SUPABASE_SERVICE_ROLE_KEY` for that same configured project, only when storage signing, imports/sync, privileged admin work or welcome-mail settings are intended. Login/session verification uses the public key with the user's session and RLS instead. The application's optional SMTP welcome email is not Supabase's required confirmation email. |
| Watch Party | `WATCH_PARTY_WORKER_URL` as the separate backend's public HTTPS origin at build and runtime; the same private 32+ character `WATCH_PARTY_SECRET` on the app and party Worker; deployed SQLite `WatchPartyRoom` with `WATCH_PARTY_ROOMS` binding; Worker `ALLOWED_ORIGINS` including the exact canonical app origin. The existing protocol supports guest capability tickets independently of Supabase. Valid config alone does not prove a reachable room backend or player synchronization. |
| Subtitles | Runtime `WYZIE_API_KEY`; optional stable private `WYZIE_SUBTITLE_TOKEN_SECRET` so capability signing is independent of API-key rotation. |

For the legacy manual GitHub Cloudflare workflow only, the four public fields,
`WATCH_PARTY_WORKER_URL` and `TMDB_API_BASE_URL` are production **Variables**.
`CLOUDFLARE_ACCOUNT_ID`, a least-privilege `CLOUDFLARE_API_TOKEN`, `TMDB_API_KEY`,
`VIDNEST_API_SECRET`, and any intended service/party/Wyzie keys above are
production **Secrets**. Cloudflare credentials are supplied only to the deploy
step, never the build. Leave both fields of each unused optional service empty.
No workflow step deploys or provisions the separate party backend.

The production resolver is the embedded VidNest/MegaPlay implementation;
`VIDNEST_API_URL` is test-only, not a supported production endpoint switch.
Do not set production to test mode or send `VIDNEST_API_SECRET` to an external
provider. The supplied API's HTML response is not a usable resolver contract;
any new provider needs a reviewed adapter and separately authorized credentials.
`FFMPEG_PATH`/`FFPROBE_PATH` configure offline Node tools only; they cannot enable
process-based transcoding inside the hosted web application. A separately authorized executor is
required for web-triggered transcoding; no job service is provisioned here.
The offline `node scripts/transcode-hls.mjs "<input.mp4>" "<output-dir>"` command
generates local HLS files only, without uploading or registering sources.

## Architecture map

```text
src/app/                 # routes, layouts, loading/error/not-found
src/components/          # reusable UI (shell, primitives)
src/features/            # catalog, player, account, admin, ads, analytics
src/lib/env.ts           # typed/validated environment + feature flags
src/lib/supabase/        # browser (client), server, service-role, Database types
src/lib/permissions/     # permission catalogue + authorization checks
src/lib/validation/      # Zod schemas (title, source/SSRF, settings) + API envelope
src/server/              # services and repositories (business logic, table access)
supabase/migrations/     # schema + RLS (0001 identity/catalog, 0002 seed, 0003 playback/ops/ads)
docs/adr/                # architecture decision records
```

**Layering:** routes → services → repositories. Services hold logic; repositories
own table details and return client-safe DTOs. Service-role keys and raw secrets
never enter a DTO or a client bundle. See `docs/adr/`:

- [0001 — Stack and architecture](docs/adr/0001-stack-and-architecture.md)
- [0002 — Provider adapter and Vidsrc/VSEmbed](docs/adr/0002-provider-adapter-and-vidsrc.md)
- [0003 — RLS-first authorization and re-auth](docs/adr/0003-rls-and-permissions.md)

## Authorization and safety notes

The Supabase-specific rules below describe the implementation; configuration
and live service readiness must be verified separately.

- **RLS-first.** Every application table has Row Level Security enabled. Public
  users read only published/public/released catalog and sanitized active ads;
  viewers read/write only their own activity; editors mutate only permissioned
  content; `audit_logs` are admin-read and append-only. The `service_role`
  bypasses RLS and is server/jobs only.
- **Effective permissions** are resolved by the SQL `has_permission(perm_key)`
  helper used by policies, mirrored app-side in `src/lib/permissions/`.
- **Sensitive actions** (role changes, secret rotation, bulk delete, account
  deletion, provider changes) require step-up re-authentication plus an audit
  event.
- **SSRF-safe URL handling.** Imported/source URLs must be https, cannot target
  private/loopback hosts, and must match a provider domain allowlist
  (`isAllowedHost` in `src/lib/validation/source.ts`).
- **Never hardcode secrets;** env is validated at startup and server secrets are
  never sent to the browser.

## Current status

- Catalogue browsing and Direct playback need the documented backend settings;
  unconfigured services return explicit unavailable/empty states, not mock data.
- Login and Watch Party are requested work, but valid configuration, verified
  sessions, and the actual backend are required. Do not force readiness flags
  or bypass email verification. Retained backend code alone is not activation.
- Local tests and builds do not verify deployed services, configured secrets,
  production providers, or sustained playback.
- `CONTEXT.md` records validation results and open issues, including the
  historical mobile hydration failure. Production payment and ad readiness
  are not established.

## Getting started

The root `.env.example` documents local development values and required server
configuration. `mobile/.env.example` is a mirror template; changing it does not
update `D:\lumora-mobile` or the existing Android APK.

See [docs/SETUP.md](docs/SETUP.md) and the ADRs for implementation/setup details,
and `CONTEXT.md` for the latest verified status and open issues. Follow the
current user authorization before applying migrations or changing remote services.
