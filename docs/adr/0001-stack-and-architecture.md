# ADR 0001 — Stack and architecture

- Status: Accepted
- Date: 2026-09-04
- Deciders: Engineering
- Context refs: prompt.md Sections 0, 6, 7, 16

## Context

Lumora is a production-grade OTT platform (editorial discovery, personal
profiles, resume watching, and a content-operations console), not a demo. It
must be server-rendered for SEO and performance, strongly typed end to end,
authorization-first, and runnable at every step — including before any external
service (Supabase, TMDB, providers) is configured.

## Decision

**Framework: Next.js App Router + React + strict TypeScript.**
Server Components are the default; client components are opt-in for interactive
surfaces (player, forms, command search). This gives us server rendering of
catalog/metadata, streaming, and colocated route-level `loading`/`error`/
`not-found` states without shipping a data layer to the browser.

**Backend: Supabase (Postgres + Auth + Storage + Realtime).**
Postgres gives us relational integrity, full-text/trigram search, and — most
importantly — Row Level Security so authorization lives next to the data (see
ADR 0003). Supabase Auth covers email/password, magic link, and OAuth without a
bespoke identity service.

**Layering: routes → services → repositories.**
- `src/app/**` route handlers and pages call **services** (`src/features/**`,
  `src/server/**`).
- Services hold business logic and call **repositories**, which own table
  details and query construction.
- Repositories return client-safe DTOs. Service-role keys and raw secrets never
  cross into a DTO or a client bundle.

This keeps table shapes swappable: today several read services return mock data
so the app runs without Supabase; the repository body is replaced later without
changing callers.

**Supabase client boundary: `src/lib/supabase/`.**
- `client.ts` — browser client (public anon key only).
- `server.ts` — request-scoped server client wired to Next `cookies()`; RLS
  applies as the signed-in user.
- `service.ts` — service-role client, **server-only**, bypasses RLS, for
  jobs/webhooks. Guarded so importing it in the browser throws.
- `types.ts` — hand-written `Database` type stub, replaceable by
  `supabase gen types`.

**Validated, typed environment (`src/lib/env.ts`).**
Public and server env vars are parsed with Zod. Public vars are referenced by
literal keys so Next can inline them; server secrets are read lazily via
`serverEnv()` which throws in the browser. `features` flags (e.g.
`supabaseConfigured`) drive graceful degradation to mock mode.

**Validation: Zod (`src/lib/validation/`).** One schema layer shared by route
handlers and services. All external input (forms, imports, webhooks, provider
URLs) is validated before use. The standard API envelope is
`{ data, error, requestId }`.

**Testing: Vitest + Testing Library + Playwright** (unit/integration/e2e), with
accessibility assertions, gated in CI alongside typecheck, lint, migrations, and
a production build.

## Consequences

- Strong type-safety and a clear authorization story; less logic duplicated
  between client and server.
- The app is always runnable: mock mode covers unconfigured environments, so
  UI/product work never blocks on infra.
- The `Database` type stub must be kept roughly in sync with migrations until it
  is regenerated from the live schema.
- Discipline is required to keep server-only modules (service client, secrets)
  out of client bundles; we rely on `next/headers`, lazy `serverEnv()`, and
  explicit runtime guards (the `server-only` package is not installed).

## Alternatives considered

- **Pages Router / SPA** — rejected: worse SEO and server-rendering ergonomics
  for a catalog product.
- **Custom Node/Nest API + separate Postgres** — rejected for v1: more infra and
  a hand-rolled authN/Z layer versus Supabase Auth + RLS.
- **ORM (Prisma/Drizzle)** — deferred: RLS in the database is our primary
  authorization boundary; thin typed repositories over supabase-js avoid a second
  source of truth for access rules. Revisit if query complexity grows.
