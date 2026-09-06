# ADR 0003 — RLS-first authorization and re-auth for sensitive actions

- Status: Accepted
- Date: 2026-09-04
- Deciders: Engineering, Security
- Context refs: prompt.md Sections 7, 8, 15

## Context

Lumora has five trust levels (visitor, viewer, editor/ad-manager/support,
administrator, owner) and strict data-visibility rules: public users see only
published/public/released catalog and sanitized active ads; viewers touch only
their own activity; editors mutate only permissioned content; audit logs are
admin-read and append-only. Authorization must not depend on every call site
remembering to filter correctly.

## Decision

**Row Level Security is the primary authorization boundary.** RLS is enabled on
every application table (migrations 0001 and 0003). Even if a query forgets a
`where` clause, the database returns only rows the caller may see. The
service-role client (server/jobs only) bypasses RLS by design and is used
sparingly.

**Effective permissions via a SQL function.** Migration 0001 defines:

```sql
public.has_permission(perm_key text) returns boolean  -- SECURITY DEFINER
```

It resolves the caller's `account_members → role_permissions → permissions` and
is the single source of truth used throughout RLS policies (e.g.
`has_permission('catalog.create')`, `'provider.manage'`, `'ads.manage'`,
`'settings.manage'`, `'audit.read'`). Publication eligibility uses
`public.title_is_public(titles)`.

**Permissions enumerated once on the app side.** `src/lib/permissions/` mirrors
the seeded permission keys (`catalog.read/create/publish/delete`,
`provider.manage`, `ads.manage`, `email.manage`, `users.read/suspend`,
`roles.manage`, `analytics.read`, `settings.manage`, `audit.read`,
`health.read`) as a typed union. `requirePermission()` / `hasPermission()`
authorize in services/route handlers **before** touching data so we can return a
clean 403 instead of leaking an empty result set. These helpers mirror the SQL
`has_permission` logic (querying `account_members`/`role_permissions`) and
degrade to `false` when Supabase is unconfigured — nothing privileged is granted
by default.

Defense in depth: app-layer checks give good UX and early rejection; RLS is the
real guarantee at the database.

**Append-only audit logs.** `audit_logs` has admin-read (`audit.read`) and an
insert policy only; there is deliberately **no** update or delete policy, so with
RLS enabled the table is immutable to every non-service role.

**Re-authentication for sensitive actions (Section 8).** Role changes, secret
rotation, bulk delete, account deletion, and provider changes require a fresh
re-auth plus an audit event. `SENSITIVE_ACTIONS` and `requiresReauth(action)`
live in `src/lib/permissions/permissions.ts`; holding the permission is
necessary but not sufficient — the action also demands recent authentication.

## Consequences

- Authorization is centralized and hard to bypass; new tables must ship with RLS
  and policies as part of the migration (checklist item).
- Policies call `has_permission`, so permission changes propagate everywhere at
  once.
- App-layer permission checks add a round trip but improve error UX and let us
  fail fast; they never replace RLS.
- Testing must cover anonymous/viewer/editor/admin/owner boundaries and the
  append-only audit guarantee.

## Alternatives considered

- **App-only authorization (no RLS)** — rejected: one missing filter becomes an
  IDOR/data-leak; violates the security model.
- **Hardcoded role checks instead of permissions** — rejected: inflexible; the
  permission indirection lets owners recompose roles without code changes.
- **Soft-deletable audit logs** — rejected: auditability requires immutability.
