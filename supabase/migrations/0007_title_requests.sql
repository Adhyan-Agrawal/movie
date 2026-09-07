-- Title requests (Spec Section 4: "request a movie/series not in the catalog").
--
-- Signed-in viewers submit requests for titles the catalog doesn't have yet;
-- catalog editors see the queue and can import the requested title from TMDB or
-- mark it rejected. RLS scopes rows to the requesting account; admins read all
-- via catalog.read and change status via catalog.create.

do $$ begin
  create type title_request_status as enum ('pending', 'imported', 'rejected');
exception when duplicate_object then null; end $$;

create table if not exists title_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  title_name text not null,
  media_type title_type not null default 'movie',
  year smallint check (year is null or (year between 1878 and 2100)),
  note text,
  status title_request_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists title_requests_status_idx on title_requests (status);
create index if not exists title_requests_account_idx on title_requests (account_id);

alter table title_requests enable row level security;

-- Viewers: insert/read/update/delete only their own requests.
drop policy if exists title_requests_self_insert on title_requests;
create policy title_requests_self_insert on title_requests
  for insert with check (account_id = auth.uid());
drop policy if exists title_requests_self_read on title_requests;
create policy title_requests_self_read on title_requests
  for select using (account_id = auth.uid());
drop policy if exists title_requests_self_update on title_requests;
create policy title_requests_self_update on title_requests
  for update using (account_id = auth.uid()) with check (account_id = auth.uid());
drop policy if exists title_requests_self_delete on title_requests;
create policy title_requests_self_delete on title_requests
  for delete using (account_id = auth.uid());

-- Editors: read the whole queue, change status (import/reject).
drop policy if exists title_requests_admin_read on title_requests;
create policy title_requests_admin_read on title_requests
  for select using (public.has_permission('catalog.read'));
drop policy if exists title_requests_admin_update on title_requests;
create policy title_requests_admin_update on title_requests
  for update using (public.has_permission('catalog.create'));
