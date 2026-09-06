-- Lumora playback / engagement / operations / advertising schema (Section 7).
-- Second schema migration; extends 0001 (identity/RBAC + core catalog) and
-- reuses its helpers `public.has_permission(perm_key)` and
-- `public.title_is_public(titles)`. Apply AFTER 0001 and 0002.
--
-- Conventions (consistent with 0001): UUID keys, UTC `timestamptz`, foreign
-- keys with sensible on-delete behaviour, check constraints, unique constraints,
-- query-driven indexes, and RLS ENABLED on every application table.
--
-- Authorization summary (Section 7):
--   * Public/anon can read only published, public, released catalog and enabled
--     (sanitized) ad placements. Raw provider/source/ad config is server-only.
--   * Viewers read/write only their own profile activity (progress, watchlist,
--     ratings, reviews, recent searches, notifications) via account ownership.
--   * Editors mutate catalog via has_permission('catalog.create'); providers and
--     sources via has_permission('provider.manage'); ads via has_permission('ads.manage').
--   * audit_logs are admin-read (audit.read) and append-only (no update/delete).
--   * The Supabase `service_role` bypasses RLS and is used by jobs/webhooks only.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type media_source_kind as enum (
    'mp4', 'hls', 'dash', 'youtube', 'vimeo', 'dailymotion', 'vsembed', 'iframe', 'embed', 'custom'
  );
exception when duplicate_object then null; end $$;
do $$ begin
  create type source_health as enum ('unknown', 'healthy', 'degraded', 'down');
exception when duplicate_object then null; end $$;
do $$ begin
  create type review_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;
do $$ begin
  create type comment_status as enum ('visible', 'pending', 'hidden', 'removed');
exception when duplicate_object then null; end $$;
do $$ begin
  create type notification_kind as enum ('system', 'availability', 'episode', 'moderation', 'security', 'import');
exception when duplicate_object then null; end $$;
do $$ begin
  create type import_kind as enum ('csv', 'json', 'tmdb');
exception when duplicate_object then null; end $$;
do $$ begin
  create type import_status as enum ('pending', 'running', 'completed', 'failed', 'partial');
exception when duplicate_object then null; end $$;
do $$ begin
  create type webhook_status as enum ('received', 'processed', 'failed', 'skipped');
exception when duplicate_object then null; end $$;
do $$ begin
  create type audit_outcome as enum ('success', 'failure');
exception when duplicate_object then null; end $$;
do $$ begin
  create type ad_format as enum ('preroll', 'midroll', 'postroll', 'display', 'native', 'banner', 'house');
exception when duplicate_object then null; end $$;
do $$ begin
  create type ad_event_type as enum ('impression', 'click', 'complete', 'skip', 'error');
exception when duplicate_object then null; end $$;

-- Sentinel used to make (…, episode_id) unique keys collapse NULLs to one row.
-- '00000000-0000-0000-0000-000000000000' never collides with gen_random_uuid().

-- ===========================================================================
-- CATALOG EXTRAS
-- ===========================================================================

create table if not exists seasons (
  id uuid primary key default gen_random_uuid(),
  title_id uuid not null references titles (id) on delete cascade,
  season_number integer not null check (season_number >= 0),
  name text,
  overview text not null default '',
  air_date date,
  poster_url text,
  episode_count integer check (episode_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (title_id, season_number)
);
create index if not exists seasons_title_idx on seasons (title_id);

alter table seasons enable row level security;
drop policy if exists seasons_public_read on seasons;
create policy seasons_public_read on seasons
  for select using (
    exists (select 1 from titles t where t.id = seasons.title_id and public.title_is_public(t))
  );
drop policy if exists seasons_editor_read on seasons;
create policy seasons_editor_read on seasons
  for select using (public.has_permission('catalog.read'));
drop policy if exists seasons_editor_write on seasons;
create policy seasons_editor_write on seasons
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

create table if not exists episodes (
  id uuid primary key default gen_random_uuid(),
  title_id uuid not null references titles (id) on delete cascade,
  season_id uuid references seasons (id) on delete cascade,
  season_number integer check (season_number >= 0),
  episode_number integer not null check (episode_number >= 0),
  name text not null,
  overview text not null default '',
  air_date date,
  runtime_minutes integer check (runtime_minutes >= 0),
  still_url text,
  tmdb_id integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (season_id, episode_number)
);
create index if not exists episodes_title_idx on episodes (title_id);
create index if not exists episodes_season_idx on episodes (season_id);

alter table episodes enable row level security;
drop policy if exists episodes_public_read on episodes;
create policy episodes_public_read on episodes
  for select using (
    exists (select 1 from titles t where t.id = episodes.title_id and public.title_is_public(t))
  );
drop policy if exists episodes_editor_read on episodes;
create policy episodes_editor_read on episodes
  for select using (public.has_permission('catalog.read'));
drop policy if exists episodes_editor_write on episodes;
create policy episodes_editor_write on episodes
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  tmdb_id integer,
  name text not null,
  known_for text,
  biography text not null default '',
  birthday date,
  profile_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists people_tmdb_idx on people (tmdb_id) where tmdb_id is not null;
create index if not exists people_name_trgm_idx on people using gin (name gin_trgm_ops);

alter table people enable row level security;
drop policy if exists people_public_read on people;
create policy people_public_read on people
  for select using (true);
drop policy if exists people_editor_write on people;
create policy people_editor_write on people
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

create table if not exists title_people (
  id uuid primary key default gen_random_uuid(),
  title_id uuid not null references titles (id) on delete cascade,
  person_id uuid not null references people (id) on delete cascade,
  credit_type text not null check (credit_type in ('cast', 'crew')),
  character text,
  job text,
  department text,
  credit_order integer not null default 0
);
-- A UNIQUE table constraint may only list bare columns, so the
-- COALESCE-based dedup rule is expressed as a unique index instead. This
-- treats NULL job/character as '' so the same person can't be inserted twice
-- for the same credit type with an equivalent (null-vs-empty) role.
create unique index if not exists title_people_unique_credit_idx
  on title_people (title_id, person_id, credit_type, coalesce(job, ''), coalesce(character, ''));
create index if not exists title_people_title_idx on title_people (title_id);
create index if not exists title_people_person_idx on title_people (person_id);

alter table title_people enable row level security;
drop policy if exists title_people_public_read on title_people;
create policy title_people_public_read on title_people
  for select using (
    exists (
      select 1 from titles t
      where t.id = title_people.title_id
        and (public.title_is_public(t) or public.has_permission('catalog.read'))
    )
  );
drop policy if exists title_people_editor_write on title_people;
create policy title_people_editor_write on title_people
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

create table if not exists collections (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  kind text not null default 'editorial' check (kind in ('editorial', 'franchise', 'auto')),
  is_public boolean not null default true,
  sort_order integer not null default 0,
  published_at timestamptz,
  created_by uuid references accounts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists collections_visibility_idx on collections (is_public, published_at);

alter table collections enable row level security;
drop policy if exists collections_public_read on collections;
create policy collections_public_read on collections
  for select using (is_public and (published_at is null or published_at <= now()));
drop policy if exists collections_editor_read on collections;
create policy collections_editor_read on collections
  for select using (public.has_permission('catalog.read'));
drop policy if exists collections_editor_write on collections;
create policy collections_editor_write on collections
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

create table if not exists collection_items (
  collection_id uuid not null references collections (id) on delete cascade,
  title_id uuid not null references titles (id) on delete cascade,
  sort_order integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (collection_id, title_id)
);
create index if not exists collection_items_title_idx on collection_items (title_id);

alter table collection_items enable row level security;
drop policy if exists collection_items_public_read on collection_items;
create policy collection_items_public_read on collection_items
  for select using (
    exists (
      select 1 from collections c
      where c.id = collection_items.collection_id
        and ((c.is_public and (c.published_at is null or c.published_at <= now()))
             or public.has_permission('catalog.read'))
    )
  );
drop policy if exists collection_items_editor_write on collection_items;
create policy collection_items_editor_write on collection_items
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

alter table tags enable row level security;
drop policy if exists tags_public_read on tags;
create policy tags_public_read on tags for select using (true);
drop policy if exists tags_editor_write on tags;
create policy tags_editor_write on tags
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

create table if not exists title_tags (
  title_id uuid not null references titles (id) on delete cascade,
  tag_id uuid not null references tags (id) on delete cascade,
  primary key (title_id, tag_id)
);
create index if not exists title_tags_tag_idx on title_tags (tag_id);

alter table title_tags enable row level security;
drop policy if exists title_tags_public_read on title_tags;
create policy title_tags_public_read on title_tags
  for select using (
    exists (
      select 1 from titles t
      where t.id = title_tags.title_id
        and (public.title_is_public(t) or public.has_permission('catalog.read'))
    )
  );
drop policy if exists title_tags_editor_write on title_tags;
create policy title_tags_editor_write on title_tags
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

-- ===========================================================================
-- PLAYBACK
-- ===========================================================================

-- Provider configuration (Section 9). Raw config (base URL, allowlists, path
-- templates) is server-only; the client receives only sanitized, server-built
-- URLs. Managed under provider.manage.
create table if not exists providers (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  adapter text not null default 'generic',
  enabled boolean not null default true,
  base_url text,
  allowed_domains text[] not null default '{}',
  movie_path_template text,
  series_path_template text,
  episode_path_template text,
  shorthand_episode_template text,
  priority integer not null default 100,
  timeout_ms integer not null default 8000 check (timeout_ms > 0),
  enabled_regions text[] not null default '{}',
  consent_required boolean not null default false,
  test_title_id text,
  config jsonb not null default '{}'::jsonb,
  health source_health not null default 'unknown',
  created_by uuid references accounts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table providers enable row level security;
drop policy if exists providers_manage on providers;
create policy providers_manage on providers
  for all using (public.has_permission('provider.manage'))
  with check (public.has_permission('provider.manage'));

create table if not exists media_sources (
  id uuid primary key default gen_random_uuid(),
  title_id uuid not null references titles (id) on delete cascade,
  episode_id uuid references episodes (id) on delete cascade,
  provider_id uuid references providers (id) on delete set null,
  kind media_source_kind not null,
  url text,
  reference text,
  label text not null default '',
  language text not null default 'en',
  quality text not null default 'auto',
  priority integer not null default 100,
  is_default boolean not null default false,
  enabled boolean not null default true,
  consent_required boolean not null default false,
  geo_policy jsonb not null default '{"mode":"allow","regions":[]}'::jsonb,
  safe_headers jsonb not null default '{}'::jsonb,
  health source_health not null default 'unknown',
  last_checked_at timestamptz,
  created_by uuid references accounts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (url is not null or reference is not null)
);
create index if not exists media_sources_title_idx on media_sources (title_id);
create index if not exists media_sources_episode_idx on media_sources (episode_id);
create index if not exists media_sources_provider_idx on media_sources (provider_id);
-- At most one default source per (title, episode) slot.
create unique index if not exists media_sources_one_default_idx
  on media_sources (title_id, coalesce(episode_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_default;

-- Raw sources (URLs, headers) are server-only; playback resolution runs
-- server-side and returns sanitized data. Managed under provider.manage.
alter table media_sources enable row level security;
drop policy if exists media_sources_manage on media_sources;
create policy media_sources_manage on media_sources
  for all using (public.has_permission('provider.manage'))
  with check (public.has_permission('provider.manage'));

create table if not exists subtitle_tracks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references media_sources (id) on delete cascade,
  title_id uuid not null references titles (id) on delete cascade,
  language text not null,
  label text,
  kind text not null default 'subtitles' check (kind in ('subtitles', 'captions', 'sdh', 'forced')),
  url text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists subtitle_tracks_source_idx on subtitle_tracks (source_id);
create index if not exists subtitle_tracks_title_idx on subtitle_tracks (title_id);

alter table subtitle_tracks enable row level security;
drop policy if exists subtitle_tracks_read on subtitle_tracks;
create policy subtitle_tracks_read on subtitle_tracks
  for select using (
    public.has_permission('provider.manage')
    or exists (select 1 from titles t where t.id = subtitle_tracks.title_id and public.title_is_public(t))
  );
drop policy if exists subtitle_tracks_write on subtitle_tracks;
create policy subtitle_tracks_write on subtitle_tracks
  for all using (public.has_permission('provider.manage'))
  with check (public.has_permission('provider.manage'));

create table if not exists audio_tracks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references media_sources (id) on delete cascade,
  title_id uuid not null references titles (id) on delete cascade,
  language text not null,
  label text,
  channels text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists audio_tracks_source_idx on audio_tracks (source_id);
create index if not exists audio_tracks_title_idx on audio_tracks (title_id);

alter table audio_tracks enable row level security;
drop policy if exists audio_tracks_read on audio_tracks;
create policy audio_tracks_read on audio_tracks
  for select using (
    public.has_permission('provider.manage')
    or exists (select 1 from titles t where t.id = audio_tracks.title_id and public.title_is_public(t))
  );
drop policy if exists audio_tracks_write on audio_tracks;
create policy audio_tracks_write on audio_tracks
  for all using (public.has_permission('provider.manage'))
  with check (public.has_permission('provider.manage'));

create table if not exists playback_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  profile_id uuid references profiles (id) on delete set null,
  title_id uuid not null references titles (id) on delete cascade,
  episode_id uuid references episodes (id) on delete set null,
  source_id uuid references media_sources (id) on delete set null,
  provider_id uuid references providers (id) on delete set null,
  device text,
  state text not null default 'idle',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists playback_sessions_account_idx on playback_sessions (account_id);
create index if not exists playback_sessions_profile_idx on playback_sessions (profile_id);
create index if not exists playback_sessions_title_idx on playback_sessions (title_id);

alter table playback_sessions enable row level security;
drop policy if exists playback_sessions_self_all on playback_sessions;
create policy playback_sessions_self_all on playback_sessions
  for all using (account_id = auth.uid())
  with check (account_id = auth.uid());
drop policy if exists playback_sessions_admin_read on playback_sessions;
create policy playback_sessions_admin_read on playback_sessions
  for select using (public.has_permission('analytics.read'));

create table if not exists watch_progress (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  title_id uuid not null references titles (id) on delete cascade,
  episode_id uuid references episodes (id) on delete cascade,
  position_seconds integer not null default 0 check (position_seconds >= 0),
  duration_seconds integer check (duration_seconds >= 0),
  progress real not null default 0 check (progress >= 0 and progress <= 1),
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Unique per (profile, title, episode); NULL episode collapses to one row.
create unique index if not exists watch_progress_unique_idx
  on watch_progress (profile_id, title_id, coalesce(episode_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists watch_progress_recent_idx on watch_progress (profile_id, updated_at desc);

alter table watch_progress enable row level security;
drop policy if exists watch_progress_self_all on watch_progress;
create policy watch_progress_self_all on watch_progress
  for all using (account_id = auth.uid())
  with check (account_id = auth.uid());

-- ===========================================================================
-- ENGAGEMENT
-- ===========================================================================

create table if not exists watchlists (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  name text not null default 'My List',
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists watchlists_profile_idx on watchlists (profile_id);
create index if not exists watchlists_account_idx on watchlists (account_id);

alter table watchlists enable row level security;
drop policy if exists watchlists_self_all on watchlists;
create policy watchlists_self_all on watchlists
  for all using (account_id = auth.uid())
  with check (account_id = auth.uid());

create table if not exists watchlist_items (
  watchlist_id uuid not null references watchlists (id) on delete cascade,
  title_id uuid not null references titles (id) on delete cascade,
  sort_order integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (watchlist_id, title_id)
);
create index if not exists watchlist_items_title_idx on watchlist_items (title_id);

alter table watchlist_items enable row level security;
drop policy if exists watchlist_items_self_all on watchlist_items;
create policy watchlist_items_self_all on watchlist_items
  for all using (
    exists (select 1 from watchlists w where w.id = watchlist_items.watchlist_id and w.account_id = auth.uid())
  )
  with check (
    exists (select 1 from watchlists w where w.id = watchlist_items.watchlist_id and w.account_id = auth.uid())
  );

create table if not exists ratings (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  title_id uuid not null references titles (id) on delete cascade,
  value smallint not null check (value between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, title_id)
);
create index if not exists ratings_title_idx on ratings (title_id);

alter table ratings enable row level security;
drop policy if exists ratings_self_all on ratings;
create policy ratings_self_all on ratings
  for all using (account_id = auth.uid())
  with check (account_id = auth.uid());
drop policy if exists ratings_admin_read on ratings;
create policy ratings_admin_read on ratings
  for select using (public.has_permission('analytics.read'));

create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  title_id uuid not null references titles (id) on delete cascade,
  body text not null,
  rating smallint check (rating between 1 and 10),
  status review_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, title_id)
);
create index if not exists reviews_title_idx on reviews (title_id);

alter table reviews enable row level security;
drop policy if exists reviews_public_read on reviews;
create policy reviews_public_read on reviews
  for select using (
    status = 'approved'
    and exists (select 1 from titles t where t.id = reviews.title_id and public.title_is_public(t))
  );
drop policy if exists reviews_self_read on reviews;
create policy reviews_self_read on reviews
  for select using (account_id = auth.uid());
drop policy if exists reviews_self_insert on reviews;
create policy reviews_self_insert on reviews
  for insert with check (account_id = auth.uid());
drop policy if exists reviews_self_update on reviews;
create policy reviews_self_update on reviews
  for update using (account_id = auth.uid()) with check (account_id = auth.uid());
drop policy if exists reviews_self_delete on reviews;
create policy reviews_self_delete on reviews
  for delete using (account_id = auth.uid());
-- Moderators (catalog editors) can read all and change status/remove.
drop policy if exists reviews_moderate on reviews;
create policy reviews_moderate on reviews
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  title_id uuid not null references titles (id) on delete cascade,
  parent_id uuid references comments (id) on delete cascade,
  body text not null,
  status comment_status not null default 'visible',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists comments_title_idx on comments (title_id);
create index if not exists comments_parent_idx on comments (parent_id);

alter table comments enable row level security;
drop policy if exists comments_public_read on comments;
create policy comments_public_read on comments
  for select using (
    status = 'visible'
    and exists (select 1 from titles t where t.id = comments.title_id and public.title_is_public(t))
  );
drop policy if exists comments_self_read on comments;
create policy comments_self_read on comments
  for select using (account_id = auth.uid());
drop policy if exists comments_self_insert on comments;
create policy comments_self_insert on comments
  for insert with check (account_id = auth.uid());
drop policy if exists comments_self_update on comments;
create policy comments_self_update on comments
  for update using (account_id = auth.uid()) with check (account_id = auth.uid());
drop policy if exists comments_self_delete on comments;
create policy comments_self_delete on comments
  for delete using (account_id = auth.uid());
drop policy if exists comments_moderate on comments;
create policy comments_moderate on comments
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

create table if not exists recent_searches (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  query text not null,
  created_at timestamptz not null default now()
);
create index if not exists recent_searches_recent_idx on recent_searches (profile_id, created_at desc);

alter table recent_searches enable row level security;
drop policy if exists recent_searches_self_all on recent_searches;
create policy recent_searches_self_all on recent_searches
  for all using (account_id = auth.uid())
  with check (account_id = auth.uid());

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  profile_id uuid references profiles (id) on delete cascade,
  kind notification_kind not null default 'system',
  title text not null,
  body text not null default '',
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recent_idx on notifications (account_id, created_at desc);
create index if not exists notifications_unread_idx on notifications (account_id) where read_at is null;

-- Owners read and mark their own notifications; inserts are done server-side
-- (service role) so users cannot fabricate notifications for themselves.
alter table notifications enable row level security;
drop policy if exists notifications_self_read on notifications;
create policy notifications_self_read on notifications
  for select using (account_id = auth.uid());
drop policy if exists notifications_self_update on notifications;
create policy notifications_self_update on notifications
  for update using (account_id = auth.uid()) with check (account_id = auth.uid());

-- ===========================================================================
-- OPERATIONS
-- ===========================================================================

-- Only settings explicitly flagged public are world-readable (brand, logo,
-- feature toggles that drive client UI). Everything else is settings.manage.
create table if not exists site_settings (
  key text primary key,
  value jsonb not null default 'null'::jsonb,
  is_public boolean not null default false,
  description text not null default '',
  updated_by uuid references accounts (id),
  updated_at timestamptz not null default now()
);

alter table site_settings enable row level security;
drop policy if exists site_settings_public_read on site_settings;
create policy site_settings_public_read on site_settings
  for select using (is_public);
drop policy if exists site_settings_admin_read on site_settings;
create policy site_settings_admin_read on site_settings
  for select using (public.has_permission('settings.manage'));
drop policy if exists site_settings_admin_write on site_settings;
create policy site_settings_admin_write on site_settings
  for all using (public.has_permission('settings.manage'))
  with check (public.has_permission('settings.manage'));

create table if not exists feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text not null default '',
  is_public boolean not null default false,
  rollout jsonb not null default '{}'::jsonb,
  updated_by uuid references accounts (id),
  updated_at timestamptz not null default now()
);

alter table feature_flags enable row level security;
drop policy if exists feature_flags_public_read on feature_flags;
create policy feature_flags_public_read on feature_flags
  for select using (is_public);
drop policy if exists feature_flags_admin_read on feature_flags;
create policy feature_flags_admin_read on feature_flags
  for select using (public.has_permission('settings.manage'));
drop policy if exists feature_flags_admin_write on feature_flags;
create policy feature_flags_admin_write on feature_flags
  for all using (public.has_permission('settings.manage'))
  with check (public.has_permission('settings.manage'));

-- Append-only audit trail. There is intentionally NO update/delete policy, so
-- with RLS enabled rows are immutable to every non-service role. Admins read
-- via audit.read; authenticated actors may append events attributed to self,
-- and the service role writes system events.
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_account_id uuid references accounts (id) on delete set null,
  action text not null,
  entity_type text,
  entity_id text,
  reason text,
  outcome audit_outcome not null default 'success',
  before jsonb,
  after jsonb,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on audit_logs (created_at desc);
create index if not exists audit_logs_actor_idx on audit_logs (actor_account_id);
create index if not exists audit_logs_entity_idx on audit_logs (entity_type, entity_id);

alter table audit_logs enable row level security;
drop policy if exists audit_logs_admin_read on audit_logs;
create policy audit_logs_admin_read on audit_logs
  for select using (public.has_permission('audit.read'));
drop policy if exists audit_logs_append on audit_logs;
create policy audit_logs_append on audit_logs
  for insert with check (
    auth.uid() is not null and (actor_account_id = auth.uid() or actor_account_id is null)
  );

create table if not exists imports (
  id uuid primary key default gen_random_uuid(),
  kind import_kind not null,
  status import_status not null default 'pending',
  source text,
  mapping jsonb not null default '{}'::jsonb,
  dry_run boolean not null default true,
  total integer not null default 0,
  processed integer not null default 0,
  succeeded integer not null default 0,
  failed integer not null default 0,
  error_report jsonb not null default '[]'::jsonb,
  idempotency_key text,
  created_by uuid references accounts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists imports_idempotency_idx on imports (idempotency_key) where idempotency_key is not null;
create index if not exists imports_status_idx on imports (status);

alter table imports enable row level security;
drop policy if exists imports_manage on imports;
create policy imports_manage on imports
  for all using (public.has_permission('catalog.create'))
  with check (public.has_permission('catalog.create'));

-- Idempotent webhook ledger. Processing is done by the service role (bypasses
-- RLS); admins may inspect via settings.manage.
create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text,
  payload jsonb not null default '{}'::jsonb,
  signature text,
  status webhook_status not null default 'received',
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, event_id)
);
create index if not exists webhook_events_status_idx on webhook_events (status);

alter table webhook_events enable row level security;
drop policy if exists webhook_events_admin_read on webhook_events;
create policy webhook_events_admin_read on webhook_events
  for select using (public.has_permission('settings.manage'));

create table if not exists health_checks (
  id uuid primary key default gen_random_uuid(),
  component text not null,
  status source_health not null default 'unknown',
  latency_ms integer check (latency_ms >= 0),
  detail jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
create index if not exists health_checks_component_idx on health_checks (component, checked_at desc);

alter table health_checks enable row level security;
drop policy if exists health_checks_admin_read on health_checks;
create policy health_checks_admin_read on health_checks
  for select using (public.has_permission('health.read'));

-- ===========================================================================
-- ADVERTISING
-- Raw ad configuration is server-only (ads.manage). Sanitized delivery of
-- active creatives to the public is done through a server-side function/route
-- in the advertising phase (Section 11) so raw targeting/economics never reach
-- the browser via RLS row exposure. Only enabled placements (slot metadata) are
-- world-readable here.
-- ===========================================================================

create table if not exists ad_providers (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_by uuid references accounts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table ad_providers enable row level security;
drop policy if exists ad_providers_manage on ad_providers;
create policy ad_providers_manage on ad_providers
  for all using (public.has_permission('ads.manage'))
  with check (public.has_permission('ads.manage'));

create table if not exists ad_placements (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  format ad_format not null,
  position text,
  enabled boolean not null default true,
  device_targeting jsonb not null default '{}'::jsonb,
  frequency_cap integer check (frequency_cap >= 0),
  cooldown_seconds integer check (cooldown_seconds >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table ad_placements enable row level security;
drop policy if exists ad_placements_public_read on ad_placements;
create policy ad_placements_public_read on ad_placements
  for select using (enabled);
drop policy if exists ad_placements_manage on ad_placements;
create policy ad_placements_manage on ad_placements
  for all using (public.has_permission('ads.manage'))
  with check (public.has_permission('ads.manage'));

create table if not exists ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid references ad_providers (id) on delete set null,
  name text not null,
  enabled boolean not null default false,
  consent_required boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  kill_switch boolean not null default false,
  revenue_meta jsonb not null default '{}'::jsonb,
  created_by uuid references accounts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ad_campaigns_provider_idx on ad_campaigns (provider_id);

alter table ad_campaigns enable row level security;
drop policy if exists ad_campaigns_manage on ad_campaigns;
create policy ad_campaigns_manage on ad_campaigns
  for all using (public.has_permission('ads.manage'))
  with check (public.has_permission('ads.manage'));

create table if not exists ad_creatives (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references ad_campaigns (id) on delete cascade,
  placement_id uuid references ad_placements (id) on delete set null,
  format ad_format not null,
  asset_url text,
  click_url text,
  html text,
  enabled boolean not null default true,
  weight integer not null default 100 check (weight >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ad_creatives_campaign_idx on ad_creatives (campaign_id);
create index if not exists ad_creatives_placement_idx on ad_creatives (placement_id);

alter table ad_creatives enable row level security;
drop policy if exists ad_creatives_manage on ad_creatives;
create policy ad_creatives_manage on ad_creatives
  for all using (public.has_permission('ads.manage'))
  with check (public.has_permission('ads.manage'));

create table if not exists ad_events (
  id uuid primary key default gen_random_uuid(),
  creative_id uuid references ad_creatives (id) on delete set null,
  placement_id uuid references ad_placements (id) on delete set null,
  campaign_id uuid references ad_campaigns (id) on delete set null,
  account_id uuid references accounts (id) on delete set null,
  profile_id uuid references profiles (id) on delete set null,
  type ad_event_type not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ad_events_campaign_idx on ad_events (campaign_id, created_at desc);
create index if not exists ad_events_type_idx on ad_events (type);
create index if not exists ad_events_creative_idx on ad_events (creative_id);

-- Events are written server-side (service role) after consent/validation; admins
-- read for reporting via ads.manage or analytics.read.
alter table ad_events enable row level security;
drop policy if exists ad_events_admin_read on ad_events;
create policy ad_events_admin_read on ad_events
  for select using (public.has_permission('ads.manage') or public.has_permission('analytics.read'));
