# Lumora

A calm, premium OTT streaming platform — editorial discovery, personal profiles,
seamless resume watching, and a professional content-operations console. Built to
feel crafted like Apple TV, Netflix, Prime Video, Linear, and Stripe — not like a
generic dashboard.

> **Authorized use only.** Use only content, embeds, URLs, and provider
> credentials the operator is authorized to use. Do **not** bypass paywalls,
> geo-blocks, anti-bot systems, DRM, or provider restrictions. These are hard
> product constraints, not preferences.

## Stack

- **Next.js App Router** (React, strict TypeScript) — server components by
  default, route-level loading/error/not-found states.
- **Tailwind** token layer for a dark, cinematic design system.
- **Supabase** — Postgres + Auth + Storage + Realtime; **RLS on every table** is
  the primary authorization boundary.
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

**Phase 0 (foundation)** is in place and runnable: repo scaffolding, design
tokens/shell, typed env validation, Supabase migrations + RLS + seed, ADRs, and
error/empty/loading states. Data/infrastructure + documentation layer added:
Supabase clients, permissions, validation schemas, and migration `0003`.

The app runs against the **live Supabase database** (migrations 0001–0004
applied, RLS on every table, RBAC permission checks wired into the admin
console and `/api/health`). The catalog reads real titles from Postgres under
RLS — seeded with real movies/series via `node scripts/seed-real-titles.mjs`
(see [docs/SETUP.md](docs/SETUP.md)). When Supabase is not configured the app
degrades gracefully to the local mock catalog. Provider playback resolves from
each title's real TMDB/IMDb id and is allowlisted at both the server
(`assertSafeUrl`) and browser (CSP `frame-src`) layers. Later phases (per
prompt.md Section 19) cover engagement, CMS, commercial (ads/email/analytics),
and launch hardening.

## Getting started

See **[docs/SETUP.md](docs/SETUP.md)** for environment variables, applying
migrations in order (0001 → 0004), seeding the real catalog, and fallback-mode
details.
