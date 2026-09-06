-- Lumora security hardening (forward migration over 0001–0003).
--
-- 0001 and 0003 are already applied to the live database, so these fixes ship
-- as a new migration rather than edits to the originals. Every statement here
-- is idempotent (drop-if-exists before create, `if not exists`, guarded FK
-- swaps), so this file is safe to re-run.
--
-- Addresses audit findings:
--   H2/#8  audit_logs insert policy allowed forgery (actor_account_id IS NULL,
--          fully attacker-controlled system-looking events).
--   #3     reviews_self_insert/update let authors self-publish (status=approved),
--          bypassing moderation.
--   M1/#4  catalog RLS collapsed catalog.publish + catalog.delete into
--          catalog.create; publish/delete permissions were never enforced.
--   #5     accounts had no admin read/suspend policy (users.read/users.suspend
--          unused) — admin user management impossible without service_role.
--   #2     9 created_by/updated_by FKs used NO ACTION, blocking account deletion
--          (GDPR erasure). Switch to ON DELETE SET NULL.
--   #6     RLS predicate column account_id unindexed on 5 owner tables.

-- ---------------------------------------------------------------------------
-- H2 — audit_logs: no client-side inserts. System events are written by the
-- service role (which bypasses RLS); clients only read via audit.read. This
-- removes the forgery vector entirely (no authenticated user can append rows,
-- attributed or unattributed). The table stays append-only (no update/delete
-- policy) and immutable to every non-service role.
-- ---------------------------------------------------------------------------
drop policy if exists audit_logs_append on audit_logs;

-- ---------------------------------------------------------------------------
-- #3 — reviews: authors submit as 'pending' and edits re-enter moderation.
-- Only reviews_moderate (catalog editors) may set status to approved/rejected.
-- ---------------------------------------------------------------------------
drop policy if exists reviews_self_insert on reviews;
create policy reviews_self_insert on reviews
  for insert with check (account_id = auth.uid() and status = 'pending');

drop policy if exists reviews_self_update on reviews;
create policy reviews_self_update on reviews
  for update using (account_id = auth.uid())
  with check (account_id = auth.uid() and status = 'pending');

-- ---------------------------------------------------------------------------
-- M1 — split catalog write policies so catalog.create, catalog.publish, and
-- catalog.delete are distinct boundaries.
--
-- RLS cannot gate a single column (status) per-transition, so publish is
-- enforced by a BEFORE UPDATE trigger: changing `status` to/from 'published'
-- (or moving published_at) requires catalog.publish. Plain create/edit needs
-- catalog.create; delete needs catalog.delete.
--
-- Applies to `titles`. genres/title_genres keep the single catalog.create gate
-- (no publish/soft-delete lifecycle of their own).
-- ---------------------------------------------------------------------------
drop policy if exists titles_editor_write on titles;

drop policy if exists titles_editor_insert on titles;
create policy titles_editor_insert on titles
  for insert with check (public.has_permission('catalog.create'));
drop policy if exists titles_editor_update on titles;
create policy titles_editor_update on titles
  for update using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));
drop policy if exists titles_editor_delete on titles;
create policy titles_editor_delete on titles
  for delete using (public.has_permission('catalog.delete'));

-- Enforce catalog.publish on the status/published_at transition. SECURITY
-- DEFINER so the permission lookup is consistent with has_permission(); the
-- trigger only raises or passes the row through — it never bypasses RLS
-- (the row-level insert/update policies above still apply).
create or replace function public.enforce_catalog_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The service role (auth.uid() is null) is the trusted system path — seeds,
  -- imports, and admin tooling — and is exempt: it already bypasses RLS and is
  -- the documented writer for catalog lifecycle events. Authenticated actors
  -- remain constrained below.
  if auth.uid() is not null then
    -- A change in publication state (status crossing 'published', or an
    -- already-published row having its schedule moved) requires catalog.publish.
    if (new.status is distinct from old.status
          and (new.status = 'published' or old.status = 'published'))
       or (old.status = 'published'
          and new.published_at is distinct from old.published_at) then
      if not public.has_permission('catalog.publish') then
        raise exception 'catalog.publish required to change publication state'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists titles_enforce_publish on titles;
create trigger titles_enforce_publish
  before update on titles
  for each row execute function public.enforce_catalog_publish();

-- ---------------------------------------------------------------------------
-- #5 — accounts: admins with users.read may read any account; users.suspend
-- may update (intended for the is_suspended flag — narrow to that column with a
-- trigger later if admins should not edit display_name). Self read/update
-- policies from 0001 remain.
-- ---------------------------------------------------------------------------
drop policy if exists accounts_admin_read on accounts;
create policy accounts_admin_read on accounts
  for select using (public.has_permission('users.read'));

drop policy if exists accounts_admin_update on accounts;
create policy accounts_admin_update on accounts
  for update using (public.has_permission('users.suspend'))
  with check (public.has_permission('users.suspend'));

-- ---------------------------------------------------------------------------
-- #2 — creator/updater FKs to ON DELETE SET NULL so deleting an account (which
-- cascades from auth.users) never fails on these references. All columns are
-- already nullable. Guarded so re-running is a no-op.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  existing_con text;
  new_con text;
begin
  for r in
    select * from (values
      ('titles',        'created_by'),
      ('collections',   'created_by'),
      ('providers',     'created_by'),
      ('media_sources', 'created_by'),
      ('imports',       'created_by'),
      ('ad_providers',  'created_by'),
      ('ad_campaigns',  'created_by'),
      ('site_settings', 'updated_by'),
      ('feature_flags', 'updated_by')
    ) as t(tbl, col)
  loop
    -- Find whatever FK currently constrains this single column (name-agnostic),
    -- and drop it. A single-column FK on created_by/updated_by is unambiguous.
    for existing_con in
      select con.conname
      from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = cls.relnamespace
      where nsp.nspname = 'public'
        and cls.relname = r.tbl
        and con.contype = 'f'
        and con.conkey = array[
          (select attnum from pg_attribute
            where attrelid = cls.oid and attname = r.col)
        ]
    loop
      execute format('alter table public.%I drop constraint %I', r.tbl, existing_con);
    end loop;

    -- Recreate with ON DELETE SET NULL under a deterministic name.
    new_con := format('%s_%s_fkey', r.tbl, r.col);
    execute format(
      'alter table public.%I add constraint %I foreign key (%I) references public.accounts (id) on delete set null',
      r.tbl, new_con, r.col);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- #6 — index the RLS predicate column account_id on owner tables so admin /
-- account-wide scans don't seq-scan. Profile-scoped reads were already indexed.
-- ---------------------------------------------------------------------------
create index if not exists watch_progress_account_idx on watch_progress (account_id);
create index if not exists ratings_account_idx         on ratings (account_id);
create index if not exists reviews_account_idx          on reviews (account_id);
create index if not exists comments_account_idx         on comments (account_id);
create index if not exists recent_searches_account_idx  on recent_searches (account_id);
