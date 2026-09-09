-- Playback issue reports (Spec Section 9, 14).
--
-- Any viewer can submit a report when a server doesn't play ("Report playback
-- issue" in the player); catalog editors/admins (analytics.read) read the queue.
-- Only safe diagnostics are stored: no URLs, tokens, or provider identities from
-- the client — just the public "Server N" label, the player state, and optional
-- free text. RLS: insert for everyone (with a nullable account_id), reads for
-- admins only.

create table if not exists playback_reports (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references accounts (id) on delete set null,
  title_id uuid references titles (id) on delete set null,
  episode_id uuid references episodes (id) on delete set null,
  server_label text,
  player_state text,
  message text,
  created_at timestamptz not null default now()
);

create index if not exists playback_reports_created_idx on playback_reports (created_at desc);
create index if not exists playback_reports_title_idx on playback_reports (title_id);

alter table playback_reports enable row level security;

-- Any viewer may file a report (even signed out); ownership is not required for
-- insert since reports are anonymous-by-design diagnostics.
drop policy if exists playback_reports_insert on playback_reports;
create policy playback_reports_insert on playback_reports
  for insert with check (true);

-- Only admins/analysts read the queue.
drop policy if exists playback_reports_admin_read on playback_reports;
create policy playback_reports_admin_read on playback_reports
  for select using (public.has_permission('analytics.read'));
