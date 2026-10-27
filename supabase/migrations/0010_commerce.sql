-- Prepare only: no payment provider is selected and no live checkout is enabled.
begin;

insert into public.permissions (key, description) values
  ('plans.manage', 'Manage plan versions and audited manual access grants'),
  ('billing.read', 'Read subscription and manual access records')
on conflict (key) do nothing;
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key in ('owner', 'admin') and p.key in ('plans.manage', 'billing.read')
on conflict do nothing;

create or replace function public.has_permission(perm_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.accounts a
    join public.account_members am on am.account_id = a.id
    join public.role_permissions rp on rp.role_id = am.role_id
    join public.permissions p on p.id = rp.permission_id
    where a.id = auth.uid() and not a.is_suspended and p.key = perm_key
  );
$$;

create table public.commerce_plans (
  id uuid primary key default gen_random_uuid(),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  version integer not null check (version > 0),
  name text not null check (length(btrim(name)) between 1 and 100),
  description text not null default '' check (length(description) <= 2000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_minor integer not null check (price_minor between 0 and 100000000),
  billing_interval text not null check (billing_interval in ('month', 'year', 'one_time')),
  ad_free boolean not null default false,
  max_profiles integer not null default 1 check (max_profiles between 1 and 20),
  features jsonb not null default '[]'::jsonb check (jsonb_typeof(features) = 'array' and jsonb_array_length(features) <= 30),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slug, version),
  check ((status = 'draft' and published_at is null) or status <> 'draft')
);
create unique index commerce_plans_live_slug on public.commerce_plans(slug) where status = 'published';

create table public.commerce_subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  plan_id uuid not null references public.commerce_plans(id) on delete restrict,
  source text not null default 'admin_grant' check (source = 'admin_grant'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  starts_at timestamptz not null default now(),
  access_until timestamptz not null,
  reason text not null check (length(btrim(reason)) between 5 and 1000),
  granted_by uuid references public.accounts(id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references public.accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  check (access_until > starts_at),
  check ((status = 'active' and revoked_at is null) or (status = 'revoked' and revoked_at is not null))
);
create index commerce_subscriptions_account on public.commerce_subscriptions(account_id, access_until desc);

alter table public.commerce_plans enable row level security;
alter table public.commerce_subscriptions enable row level security;
create policy commerce_plans_public_read on public.commerce_plans for select
  using (status = 'published');
create policy commerce_plans_admin_read on public.commerce_plans for select
  using (public.has_permission('plans.manage') or public.has_permission('billing.read'));
create policy commerce_plans_subscription_read on public.commerce_plans for select
  using (exists (select 1 from public.commerce_subscriptions s where s.plan_id = commerce_plans.id and s.account_id = auth.uid()));
-- Self-service reads use the sanitized entitlement resolver rather than exposing
-- internal grant reasons or administrator identities from this table.
create policy commerce_subscriptions_admin_read on public.commerce_subscriptions for select
  using (public.has_permission('billing.read'));
revoke insert, update, delete on public.commerce_plans, public.commerce_subscriptions from anon, authenticated;
grant select on public.commerce_plans, public.commerce_subscriptions to anon, authenticated;
grant all on public.commerce_plans, public.commerce_subscriptions to service_role;

create function public.commerce_assert_actor(p_actor uuid, p_permission text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.accounts a
    join public.account_members m on m.account_id = a.id
    join public.role_permissions rp on rp.role_id = m.role_id
    join public.permissions p on p.id = rp.permission_id
    where a.id = p_actor and not a.is_suspended and p.key = p_permission
  ) then raise exception 'Commerce permission denied' using errcode = '42501'; end if;
end;
$$;
revoke all on function public.commerce_assert_actor(uuid, text) from public, anon, authenticated;

-- Used by both the self-read RPC and profile trigger; no grants expose other users.
create function public.commerce_entitlements_for(p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_plan record; v_ad_free boolean; v_max integer; v_until timestamptz;
begin
  if p_account is null then
    return jsonb_build_object('resolved', true, 'adFree', false, 'maxProfiles', 1, 'status', 'free');
  end if;
  if not exists (select 1 from public.accounts where id = p_account and not is_suspended) then
    return jsonb_build_object('resolved', false, 'adFree', false, 'maxProfiles', 1, 'status', 'unavailable');
  end if;
  select bool_or(p.ad_free), max(p.max_profiles), max(s.access_until)
    into v_ad_free, v_max, v_until
    from public.commerce_subscriptions s join public.commerce_plans p on p.id = s.plan_id
    where s.account_id = p_account and s.status = 'active' and s.starts_at <= now() and s.access_until > now();
  if v_until is not null then
    select p.id, p.name into v_plan from public.commerce_subscriptions s
      join public.commerce_plans p on p.id = s.plan_id
      where s.account_id = p_account and s.status = 'active' and s.starts_at <= now() and s.access_until > now()
      order by p.ad_free desc, p.max_profiles desc, s.access_until desc, s.id limit 1;
    return jsonb_build_object('resolved', true, 'adFree', v_ad_free, 'maxProfiles', v_max,
      'status', 'active', 'planId', v_plan.id, 'planName', v_plan.name, 'accessUntil', v_until);
  end if;
  select max(access_until) into v_until from public.commerce_subscriptions
    where account_id = p_account and status = 'active' and access_until <= now();
  return jsonb_strip_nulls(jsonb_build_object('resolved', true, 'adFree', false, 'maxProfiles', 1,
    'status', case when v_until is null then 'free' else 'expired' end, 'accessUntil', v_until));
end;
$$;
revoke all on function public.commerce_entitlements_for(uuid) from public, anon, authenticated;
create function public.commerce_viewer_entitlements()
returns jsonb language sql stable security definer set search_path = public as $$
  select public.commerce_entitlements_for(auth.uid());
$$;
revoke all on function public.commerce_viewer_entitlements() from public;
grant execute on function public.commerce_viewer_entitlements() to anon, authenticated;

create function public.commerce_protect_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'service_role' or session_user in ('postgres', 'supabase_admin') and auth.role() is null then return new; end if;
  if new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'Protected account columns' using errcode = '42501';
  end if;
  if new.is_suspended is distinct from old.is_suspended then
    if auth.uid() = old.id or not public.has_permission('users.suspend') then
      raise exception 'users.suspend required and self-reactivation is forbidden' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger commerce_protect_account before update on public.accounts
for each row execute function public.commerce_protect_account();

create function public.commerce_profile_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_limit integer;
begin
  if tg_op = 'UPDATE' then
    if new.account_id is distinct from old.account_id then
      raise exception 'Profile ownership is immutable' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Serialize even concurrent inserts across sessions and concurrent grants/revokes.
  perform 1 from public.accounts where id = new.account_id for update;
  -- A tuple change also makes stale REPEATABLE READ writers retry, rather than
  -- counting profiles/entitlements from a snapshot taken before the lock wait.
  update public.accounts set updated_at = now() where id = new.account_id;
  v_limit := (public.commerce_entitlements_for(new.account_id)->>'maxProfiles')::integer;
  if (select count(*) from public.profiles where account_id = new.account_id) >= v_limit then
    raise exception 'Your subscription profile limit has been reached' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger commerce_profile_limit before insert or update on public.profiles
for each row execute function public.commerce_profile_limit();

create function public.commerce_protect_plan()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.published_at is not null and (to_jsonb(new) - 'status' - 'updated_at') is distinct from
      (to_jsonb(old) - 'status' - 'updated_at') then
    raise exception 'Published plan versions are immutable; create a new version' using errcode = '23514';
  end if;
  if old.published_at is not null and new.status = 'draft' then
    raise exception 'A published version cannot become a draft' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger commerce_protect_plan before update on public.commerce_plans
for each row execute function public.commerce_protect_plan();

create function public.commerce_manage_plan(p_actor uuid, p_operation text, p_id uuid, p_payload jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_before public.commerce_plans; v_after public.commerce_plans; v_id uuid;
begin
  perform public.commerce_assert_actor(p_actor, 'plans.manage');
  if p_reason is null or length(btrim(p_reason)) not between 5 and 1000 then raise exception 'A reason is required'; end if;
  -- Serializes version allocation and publication replacement for a slug.
  perform pg_advisory_xact_lock(hashtext('commerce.plan'), 0);
  if p_operation = 'create' then
    insert into public.commerce_plans(slug, version, name, description, currency, price_minor, billing_interval, ad_free, max_profiles, features)
    values(p_payload->>'slug', (select coalesce(max(version), 0) + 1 from public.commerce_plans where slug = p_payload->>'slug'),
      p_payload->>'name', coalesce(p_payload->>'description', ''), p_payload->>'currency', (p_payload->>'priceMinor')::integer,
      p_payload->>'billingInterval', (p_payload->>'adFree')::boolean, (p_payload->>'maxProfiles')::integer, p_payload->'features')
    returning * into v_after;
  else
    select * into v_before from public.commerce_plans where id = p_id for update;
    if not found then raise exception 'Plan not found'; end if;
    if p_operation = 'update' and v_before.status = 'draft' then
      update public.commerce_plans set name = p_payload->>'name', description = coalesce(p_payload->>'description', ''),
        currency = p_payload->>'currency', price_minor = (p_payload->>'priceMinor')::integer,
        billing_interval = p_payload->>'billingInterval', ad_free = (p_payload->>'adFree')::boolean,
        max_profiles = (p_payload->>'maxProfiles')::integer, features = p_payload->'features', updated_at = now()
        where id = p_id returning * into v_after;
    elsif p_operation = 'publish' and v_before.status = 'draft' then
      -- Keep old snapshots for existing grants, never silently change their terms.
      with retired as (update public.commerce_plans set status = 'archived', updated_at = now()
        where slug = v_before.slug and status = 'published' returning *)
      insert into public.audit_logs(actor_account_id, action, entity_type, entity_id, reason, after)
        select p_actor, 'plan.supersede', 'commerce_plan', id::text, p_reason, to_jsonb(retired) from retired;
      update public.commerce_plans set status = 'published', published_at = now(), updated_at = now()
        where id = p_id returning * into v_after;
    elsif p_operation = 'archive' and v_before.status <> 'archived' then
      update public.commerce_plans set status = 'archived', updated_at = now() where id = p_id returning * into v_after;
    elsif p_operation = 'delete' and v_before.status = 'draft' then
      delete from public.commerce_plans where id = p_id;
    else raise exception 'Invalid operation for this plan version'; end if;
  end if;
  v_id := coalesce(v_after.id, v_before.id);
  insert into public.audit_logs(actor_account_id, action, entity_type, entity_id, reason, before, after)
    values(p_actor, 'plan.' || p_operation, 'commerce_plan', v_id::text, p_reason, to_jsonb(v_before), to_jsonb(v_after));
  return v_id;
end;
$$;

create function public.commerce_manage_subscription(p_actor uuid, p_operation text, p_account uuid, p_plan uuid,
  p_subscription uuid, p_access_until timestamptz, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_before public.commerce_subscriptions; v_after public.commerce_subscriptions;
begin
  perform public.commerce_assert_actor(p_actor, 'plans.manage');
  if p_reason is null or length(btrim(p_reason)) not between 5 and 1000 then raise exception 'A reason is required'; end if;
  perform 1 from public.accounts where id = p_account and not is_suspended for update;
  if not found then raise exception 'Account unavailable'; end if;
  update public.accounts set updated_at = now() where id = p_account;
  if p_operation = 'grant' then
    if p_access_until <= now() or p_access_until > now() + interval '5 years' or p_access_until is null then
      raise exception 'Access expiry must be within five years'; end if;
    perform 1 from public.commerce_plans where id = p_plan and status = 'published' for share;
    if not found then raise exception 'A published plan is required'; end if;
    insert into public.commerce_subscriptions(account_id, plan_id, access_until, reason, granted_by)
      values(p_account, p_plan, p_access_until, p_reason, p_actor) returning * into v_after;
  elsif p_operation = 'revoke' then
    select * into v_before from public.commerce_subscriptions where id = p_subscription and account_id = p_account for update;
    if not found or v_before.status <> 'active' then raise exception 'Active grant not found'; end if;
    update public.commerce_subscriptions set status = 'revoked', revoked_at = now(), revoked_by = p_actor
      where id = p_subscription returning * into v_after;
  else raise exception 'Only admin-managed grant/revoke is supported'; end if;
  insert into public.audit_logs(actor_account_id, action, entity_type, entity_id, reason, before, after)
    values(p_actor, 'subscription.' || p_operation, 'commerce_subscription', v_after.id::text, p_reason,
      to_jsonb(v_before), to_jsonb(v_after));
  return v_after.id;
end;
$$;

-- Generic settings editors cannot expose or replace the private VAST setting.
create function public.commerce_protect_vast_setting()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (case when tg_op = 'DELETE' then old.key else new.key end) = 'playback_vast'
     or (tg_op = 'UPDATE' and old.key = 'playback_vast') then
    if coalesce(auth.role(), '') <> 'service_role' and not (session_user in ('postgres', 'supabase_admin') and auth.role() is null) then
      raise exception 'VAST settings require the audited commerce service' using errcode = '42501';
    end if;
    if tg_op <> 'DELETE' and new.is_public then raise exception 'VAST configuration is server-only'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger commerce_protect_vast_setting before insert or update or delete on public.site_settings
for each row execute function public.commerce_protect_vast_setting();
insert into public.site_settings(key, value, is_public, description) values
  ('playback_vast', '{"enabled":false,"tagUrl":"","allowedHosts":[],"firstBreakSeconds":900,"intervalSeconds":900,"maxBreaks":3,"allowSkip":true,"skipAfterSeconds":5}', false,
   'Private VAST provider configuration; audited ads.manage service writes only')
on conflict (key) do update set is_public = false;

create function public.commerce_save_vast(p_actor uuid, p_config jsonb, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_before jsonb; v_host text;
begin
  perform public.commerce_assert_actor(p_actor, 'ads.manage');
  if p_reason is null or length(btrim(p_reason)) not between 5 and 1000 then raise exception 'A reason is required'; end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' or not (p_config ?& array[
    'enabled', 'allowSkip', 'tagUrl', 'allowedHosts', 'firstBreakSeconds', 'intervalSeconds', 'maxBreaks', 'skipAfterSeconds'])
    or jsonb_typeof(p_config->'enabled') <> 'boolean' or jsonb_typeof(p_config->'allowSkip') <> 'boolean'
    or jsonb_typeof(p_config->'tagUrl') <> 'string' or length(p_config->>'tagUrl') > 4096
    or jsonb_typeof(p_config->'allowedHosts') <> 'array'
    or jsonb_array_length(p_config->'allowedHosts') > 30
    or (p_config->>'firstBreakSeconds')::integer not between 60 and 86400
    or (p_config->>'intervalSeconds')::integer not between 60 and 86400
    or (p_config->>'maxBreaks')::integer not between 0 and 20
    or (p_config->>'skipAfterSeconds')::integer not between 0 and 30
    or ((p_config->>'enabled')::boolean and ((p_config->>'tagUrl') = '' or (p_config->>'maxBreaks')::integer = 0 or jsonb_array_length(p_config->'allowedHosts') = 0))
    then raise exception 'Invalid VAST scheduling configuration'; end if;
  if exists (select 1 from jsonb_array_elements_text(p_config->'allowedHosts') h(host)
    where host !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
      or host ~ '\.(local|localhost|internal|lan|home|test|invalid|home\.arpa)$' or length(host) > 253) then
    raise exception 'Invalid VAST allowed host';
  end if;
  if (p_config->>'tagUrl') <> '' then
    v_host := substring(p_config->>'tagUrl' from '^https://([^/:?#@]+)(:443)?([/?][^#]*)?$');
    if v_host is null or not (p_config->'allowedHosts' ? v_host) then raise exception 'VAST tag host must be explicitly allowed'; end if;
  end if;
  select value into v_before from public.site_settings where key = 'playback_vast' for update;
  insert into public.site_settings(key, value, is_public, updated_by) values ('playback_vast', p_config, false, p_actor)
    on conflict (key) do update set value = excluded.value, is_public = false, updated_by = p_actor, updated_at = now();
  -- Tag URLs may contain provider credentials. Audit scheduling only, never secrets.
  insert into public.audit_logs(actor_account_id, action, entity_type, entity_id, reason, before, after)
    values(p_actor, 'ads.vast.change', 'site_setting', 'playback_vast', p_reason,
      v_before - 'tagUrl', p_config - 'tagUrl');
end;
$$;

revoke all on function public.commerce_manage_plan(uuid, text, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.commerce_manage_subscription(uuid, text, uuid, uuid, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.commerce_save_vast(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.commerce_manage_plan(uuid, text, uuid, jsonb, text) to service_role;
grant execute on function public.commerce_manage_subscription(uuid, text, uuid, uuid, uuid, timestamptz, text) to service_role;
grant execute on function public.commerce_save_vast(uuid, jsonb, text) to service_role;
commit;
