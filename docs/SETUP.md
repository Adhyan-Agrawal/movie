# Lumora — Local setup

This guide covers running Lumora locally, configuring environment variables,
applying database migrations in Supabase, seeding the real catalog, and how the
app degrades to **mock mode** without Supabase. See also prompt.md Section 18
(Deployment and Operations).

## Prerequisites

- Node.js 20+ and npm
- A Supabase project (optional for UI work — see [Mock mode](#mock-mode))

## 1. Install and run

```bash
npm install
npm run dev            # http://localhost:3000
```

Useful scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint (next lint) |
| `npm run test` | Vitest unit/integration run |

## 2. Environment variables

Copy the example file and fill in what you have:

```bash
cp .env.example .env.local
```

| Variable | Scope | Required | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | public | no | Defaults to `Lumora`. |
| `NEXT_PUBLIC_APP_URL` | public | no | Defaults to `http://localhost:3000`. |
| `NEXT_PUBLIC_SUPABASE_URL` | public | for live data | Project URL. Enables Supabase mode. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | for live data | Anon key (RLS applies). |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | for jobs/webhooks | Bypasses RLS. Never expose to the browser. |
| `TMDB_API_KEY` | **server only** | for TMDB import | Server-side only. |
| `TMDB_API_BASE_URL` | server | no | Defaults to `https://api.themoviedb.org/3`. |

Env is validated by Zod in `src/lib/env.ts`. Public vars are inlined into the
browser bundle; server vars are read lazily via `serverEnv()` and throw if
accessed in the browser. Never commit real secrets — `.env.local` is gitignored.

## 3. Apply migrations (in order)

Open the Supabase dashboard → **SQL Editor** and run each file's contents, in
this exact order (or use the helper script — see below):

1. `supabase/migrations/0001_init.sql` — identity/RBAC + core catalog, the
   `has_permission` / `title_is_public` helpers, and RLS.
2. `supabase/migrations/0002_seed_rbac.sql` — seed roles + permissions and the
   `handle_new_user()` signup trigger.
3. `supabase/migrations/0003_playback_engagement.sql` — playback, engagement,
   operations, and advertising tables with RLS.
4. `supabase/migrations/0004_security_hardening.sql` — audit-log write
   lockdown, review moderation constraints, split catalog create/publish/delete
   policies (with the `catalog.publish` enforcement trigger), admin
   account-management policies, `ON DELETE SET NULL` creator FKs, and
   `account_id` RLS indexes.

All four files are idempotent (safe to re-run). To apply them from your machine
instead of the dashboard, `npm i pg --no-save` once, add
`SUPABASE_DB_PASSWORD` to `.env.local`, then run
`node scripts/apply-migrations.mjs`.

Order matters: 0003 depends on tables and helpers from 0001, 0002 seeds the
permission rows that RLS policies reference, and 0004 reshapes policies created
by 0001/0003. If you use the Supabase CLI, `supabase db push` (or
`supabase migration up`) applies them in filename order.

> RLS is enabled on every application table. A signed-in user only ever sees
> their own activity and the public catalog; privileged reads/writes require the
> matching permission (see ADR 0003). Audit-log writes are service-role-only —
> client-side inserts are rejected outright.

## 4. Seed data

- Roles and permissions are seeded by `0002_seed_rbac.sql` (idempotent).
- On first sign-up, `handle_new_user()` creates an `accounts` row and a default
  `profiles` row automatically.
- **Bootstrapping the first owner:** `0002` assigns no memberships. Grant the
  first owner out-of-band in the SQL editor, e.g.:

  ```sql
  insert into account_members (account_id, role_id)
  select a.id, r.id
  from accounts a
  cross join roles r
  where a.id = '<your-auth-user-uuid>' and r.key = 'owner'
  on conflict do nothing;
  ```

  A user with an admin/owner role sees the admin console; everyone else gets
  the "Admin access required" state (the gate is `hasAnyPermission` over the
  admin permission set in `src/app/admin/layout.tsx`).

### Real catalog seed

With the env from step 2 in place, seed real, publicly-known movies and series
(real TMDB/IMDb ids — which is what makes playback resolve):

```bash
node scripts/seed-real-titles.mjs   # 22 curated real titles, idempotent
```

This deletes the fictional placeholder titles and upserts real ones as
published/public. To enrich the catalog with official TMDB metadata (posters,
certifications, more titles) from a network that can reach api.themoviedb.org:

```bash
node scripts/seed-tmdb.mjs [--pages=N]   # fetches popular + top-rated
```

`seed-tmdb` uses the same slug convention (`<name>-<tmdbId>`), so it refreshes
the same rows rather than duplicating them. Use only content and provider
references you are authorized to use.

### Verify

`node scripts/verify-db.mjs` reports tables/RLS/policy counts and seed rows;
`node scripts/verify-0004.mjs` confirms the hardening policies landed.

## Mock mode (fallback)

The app is fully runnable **without** Supabase. When
`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` are unset,
`features.supabaseConfigured` is `false` and:

- Catalog read services fall back to the local mock catalog
  (`src/features/catalog/mock-data.ts`); home/browse responses are flagged
  `usingMockData` and the "Showing sample catalog" banner is shown so the UI is
  honest about the source. With Supabase configured, the repository
  (`src/features/catalog/repository.ts`) reads live rows under RLS and any
  transient repository failure degrades back to mock rather than erroring.
- The browser/server Supabase client factories throw a descriptive error if
  called — always gate calls behind `features.supabaseConfigured`.
- Permission checks (`hasPermission`) return `false`, so nothing privileged is
  exposed: the admin console shows its unauthorized state and `/api/health`
  returns only the minimal liveness payload.

This lets design, accessibility, and UI work proceed before any infrastructure
exists. Configure Supabase (steps 2–4) to switch to live data.

## Troubleshooting

- **"Supabase is not configured" thrown at runtime** — a client factory was
  called in mock mode. Guard it with `isSupabaseConfigured`.
- **`serverEnv() must not be called in the browser`** — a server-only module was
  imported into a client bundle. Move the call to a server component/route/
  action.
- **Typecheck fails after schema edits** — the hand-written `Database` stub in
  `src/lib/supabase/types.ts` drifted; update it or regenerate with
  `supabase gen types typescript`.
