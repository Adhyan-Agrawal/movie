-- Seed baseline roles + permissions (Section 8).
-- Idempotent: safe to re-run. Assigns no accounts; membership is granted by an
-- admin after signup, or bootstrapped out-of-band for the first owner.

insert into permissions (key, description) values
  ('catalog.read',    'Read draft/private catalog'),
  ('catalog.create',  'Create and edit catalog entries'),
  ('catalog.publish', 'Publish or unpublish titles'),
  ('catalog.delete',  'Delete catalog entries'),
  ('provider.manage', 'Manage playback providers and sources'),
  ('ads.manage',      'Manage advertising'),
  ('email.manage',    'Manage email settings and templates'),
  ('users.read',      'Read user accounts'),
  ('users.suspend',   'Suspend user accounts'),
  ('roles.manage',    'Manage roles and permissions'),
  ('analytics.read',  'Read analytics'),
  ('settings.manage', 'Manage site settings'),
  ('audit.read',      'Read audit logs'),
  ('health.read',     'Read system health')
on conflict (key) do nothing;

insert into roles (key, name) values
  ('owner',  'Owner'),
  ('admin',  'Administrator'),
  ('editor', 'Content editor'),
  ('viewer', 'Viewer')
on conflict (key) do nothing;

-- Owner + admin get every permission.
insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
cross join permissions p
where r.key in ('owner', 'admin')
on conflict do nothing;

-- Editor gets catalog-scoped permissions.
insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.key in ('catalog.read', 'catalog.create', 'catalog.publish')
where r.key = 'editor'
on conflict do nothing;

-- When a new auth user is created, mirror an accounts row and a default profile.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounts (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', 'Viewer'))
  on conflict (id) do nothing;

  insert into public.profiles (account_id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', 'Viewer'))
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
