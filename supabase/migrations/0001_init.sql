-- Lumora initial schema (Section 7).
-- Identity/RBAC + core catalog with RLS enabled on every application table.
-- UUID keys, UTC timestamps, FKs, checks, unique constraints, query-driven
-- indexes. This is the Phase 0 foundation slice; playback/engagement/ops/ad
-- tables follow in later migrations.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type title_type as enum ('movie', 'tv');
exception when duplicate_object then null; end $$;
do $$ begin
  create type title_status as enum ('draft', 'scheduled', 'published', 'archived');
exception when duplicate_object then null; end $$;
do $$ begin
  create type title_visibility as enum ('public', 'private');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Identity / RBAC
-- ---------------------------------------------------------------------------

-- One row per auth user. Mirrors auth.users(id).
create table if not exists accounts (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Viewer',
  is_suspended boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,          -- e.g. 'owner','admin','editor','viewer'
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,          -- e.g. 'catalog.publish'
  description text not null default ''
);

create table if not exists role_permissions (
  role_id uuid not null references roles (id) on delete cascade,
  permission_id uuid not null references permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

-- Assignment of roles to accounts.
create table if not exists account_members (
  account_id uuid not null references accounts (id) on delete cascade,
  role_id uuid not null references roles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (account_id, role_id)
);

-- Viewing profiles under an account.
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  name text not null,
  avatar text,
  maturity_ceiling text not null default 'TV-MA',
  is_kids boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_account_idx on profiles (account_id);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

create table if not exists genres (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null
);

create table if not exists titles (
  id uuid primary key default gen_random_uuid(),
  type title_type not null,
  tmdb_id integer,
  imdb_id text,
  slug text not null unique,
  name text not null,
  original_name text,
  synopsis text not null default '',
  release_year integer check (release_year between 1878 and 2100),
  runtime_minutes integer check (runtime_minutes >= 0),
  maturity text not null default 'NR',
  status title_status not null default 'draft',
  visibility title_visibility not null default 'public',
  original_language text not null default 'en',
  poster_url text,
  backdrop_url text,
  trailer_url text,
  featured boolean not null default false,
  editorial_score integer check (editorial_score between 0 and 100),
  published_at timestamptz,
  created_by uuid references accounts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists titles_tmdb_type_idx on titles (type, tmdb_id) where tmdb_id is not null;
create index if not exists titles_status_visibility_idx on titles (status, visibility);
create index if not exists titles_featured_idx on titles (featured) where featured;
create index if not exists titles_name_trgm_idx on titles using gin (name gin_trgm_ops);

create table if not exists title_genres (
  title_id uuid not null references titles (id) on delete cascade,
  genre_id uuid not null references genres (id) on delete cascade,
  primary key (title_id, genre_id)
);

-- ---------------------------------------------------------------------------
-- Helper: does the current user hold a permission via any assigned role?
-- ---------------------------------------------------------------------------
create or replace function public.has_permission(perm_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from account_members am
    join role_permissions rp on rp.role_id = am.role_id
    join permissions p on p.id = rp.permission_id
    where am.account_id = auth.uid()
      and p.key = perm_key
  );
$$;

-- A published, public, released title is visible to anonymous users.
create or replace function public.title_is_public(t titles)
returns boolean
language sql
stable
as $$
  select t.status = 'published'
     and t.visibility = 'public'
     and (t.published_at is null or t.published_at <= now());
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table accounts enable row level security;
alter table roles enable row level security;
alter table permissions enable row level security;
alter table role_permissions enable row level security;
alter table account_members enable row level security;
alter table profiles enable row level security;
alter table genres enable row level security;
alter table titles enable row level security;
alter table title_genres enable row level security;

-- accounts: a user reads/updates only their own row.
drop policy if exists accounts_self_read on accounts;
create policy accounts_self_read on accounts
  for select using (id = auth.uid());
drop policy if exists accounts_self_update on accounts;
create policy accounts_self_update on accounts
  for update using (id = auth.uid()) with check (id = auth.uid());

-- profiles: owned by the account.
drop policy if exists profiles_self_all on profiles;
create policy profiles_self_all on profiles
  for all using (account_id = auth.uid()) with check (account_id = auth.uid());

-- genres: public read; editors manage.
drop policy if exists genres_public_read on genres;
create policy genres_public_read on genres
  for select using (true);
drop policy if exists genres_editor_write on genres;
create policy genres_editor_write on genres
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

-- titles: public users read only published/public/released titles.
drop policy if exists titles_public_read on titles;
create policy titles_public_read on titles
  for select using (public.title_is_public(titles));
-- editors can read everything (drafts, private) ...
drop policy if exists titles_editor_read on titles;
create policy titles_editor_read on titles
  for select using (public.has_permission('catalog.read'));
-- ... and mutate with the right permission.
drop policy if exists titles_editor_write on titles;
create policy titles_editor_write on titles
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

-- title_genres: readable when the parent title is readable; editors manage.
drop policy if exists title_genres_public_read on title_genres;
create policy title_genres_public_read on title_genres
  for select using (
    exists (
      select 1 from titles t
      where t.id = title_genres.title_id
        and (public.title_is_public(t) or public.has_permission('catalog.read'))
    )
  );
drop policy if exists title_genres_editor_write on title_genres;
create policy title_genres_editor_write on title_genres
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

-- RBAC config tables: read for authenticated, mutate only via roles.manage.
drop policy if exists roles_read on roles;
create policy roles_read on roles for select using (auth.uid() is not null);
drop policy if exists roles_manage on roles;
create policy roles_manage on roles for all
  using (public.has_permission('roles.manage'))
  with check (public.has_permission('roles.manage'));

drop policy if exists permissions_read on permissions;
create policy permissions_read on permissions for select using (auth.uid() is not null);
drop policy if exists permissions_manage on permissions;
create policy permissions_manage on permissions for all
  using (public.has_permission('roles.manage'))
  with check (public.has_permission('roles.manage'));

drop policy if exists role_permissions_read on role_permissions;
create policy role_permissions_read on role_permissions for select using (auth.uid() is not null);
drop policy if exists role_permissions_manage on role_permissions;
create policy role_permissions_manage on role_permissions for all
  using (public.has_permission('roles.manage'))
  with check (public.has_permission('roles.manage'));

-- account_members: a user can see their own memberships; admins manage.
drop policy if exists account_members_self_read on account_members;
create policy account_members_self_read on account_members
  for select using (account_id = auth.uid() or public.has_permission('users.read'));
drop policy if exists account_members_manage on account_members;
create policy account_members_manage on account_members for all
  using (public.has_permission('roles.manage'))
  with check (public.has_permission('roles.manage'));
