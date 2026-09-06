-- Watchlists (Spec Section 7 engagement tables: `watchlists`, `watchlist_items`).
-- One default list per profile for v1 (multiple named lists supported by the
-- unique (profile_id, name) key). account_id is denormalized onto the list so
-- RLS can scope every row to its owner with a single-column predicate.
-- Idempotent; safe to re-run. (Recreates the tables from an earlier draft of
-- this migration — they shipped moments ago and hold no rows.)

drop table if exists watchlist_items;
drop table if exists watchlists;

create table if not exists watchlists (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  account_id uuid not null references accounts (id) on delete cascade,
  name text not null default 'My list',
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, name)
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

create index if not exists watchlist_items_watchlist_idx on watchlist_items (watchlist_id);
create index if not exists watchlist_items_title_idx on watchlist_items (title_id);

alter table watchlist_items enable row level security;

-- Items follow their list's ownership.
drop policy if exists watchlist_items_self_all on watchlist_items;
create policy watchlist_items_self_all on watchlist_items
  for all using (
    exists (
      select 1 from watchlists w
      where w.id = watchlist_items.watchlist_id and w.account_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from watchlists w
      where w.id = watchlist_items.watchlist_id and w.account_id = auth.uid()
    )
  );
