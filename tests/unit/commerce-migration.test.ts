import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Static migration regression checks only. Never connect to or modify a database.
const sql = readFileSync(new URL('../../supabase/migrations/0010_commerce.sql', import.meta.url), 'utf8');
function body(name: string) {
  const result = sql.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`));
  if (!result) throw new Error(`Missing function ${name}`);
  return result[1]!;
}

describe('commerce migration security invariants', () => {
  it('prepares a single transactional forward migration', () => {
    expect(sql).toMatch(/\bbegin;/); expect(sql).toMatch(/commit;\s*$/);
    expect(sql).toContain("('plans.manage'"); expect(sql).toContain("('billing.read'");
  });
  it('enables RLS, limits self reads to sanitized entitlements and revokes direct client writes', () => {
    expect(sql).toContain('alter table public.commerce_plans enable row level security');
    expect(sql).toContain('alter table public.commerce_subscriptions enable row level security');
    expect(sql).not.toMatch(/create policy commerce_subscriptions_self_read\b/);
    expect(sql).toMatch(/create policy commerce_subscriptions_admin_read on public\.commerce_subscriptions for select\s+using \(public\.has_permission\('billing\.read'\)\)/);
    expect(sql).toContain('create function public.commerce_viewer_entitlements()\nreturns jsonb language sql stable security definer set search_path = public as $$');
    expect(body('commerce_viewer_entitlements').trim()).toBe('select public.commerce_entitlements_for(auth.uid());');
    expect(body('commerce_entitlements_for')).not.toMatch(/\b(reason|granted_by|revoked_by)\b/);
    expect(sql).toContain('revoke all on function public.commerce_entitlements_for(uuid) from public, anon, authenticated;');
    expect(sql).toContain('revoke all on function public.commerce_viewer_entitlements() from public;');
    expect(sql).toContain('grant execute on function public.commerce_viewer_entitlements() to anon, authenticated;');
    expect(sql).toContain('revoke insert, update, delete on public.commerce_plans, public.commerce_subscriptions from anon, authenticated');
  });
  it.each(['commerce_manage_plan', 'commerce_manage_subscription', 'commerce_save_vast'])('sensitive RPC %s is service-only, permissioned, reasoned and transactional with audit', (name) => {
    expect(sql).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^;]*from public, anon, authenticated;`));
    expect(sql).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^;]*to service_role;`));
    const fn = body(name); expect(fn).toContain('commerce_assert_actor'); expect(fn).toContain('p_reason is null');
    expect(fn).toContain('insert into public.audit_logs');
  });
  it('checks the real actor membership and suspended account, not a spoofable auth-null bypass', () => {
    const actor = body('commerce_assert_actor'); expect(actor).toContain('a.id = p_actor and not a.is_suspended');
    expect(actor).toContain('p.key = p_permission');
  });
  it('serializes profile inserts and grants on the same account row', () => {
    const profiles = body('commerce_profile_limit'); const grants = body('commerce_manage_subscription');
    expect(profiles).toContain('where id = new.account_id for update'); expect(grants).toContain('where id = p_account and not is_suspended for update');
    expect(profiles.indexOf('for update')).toBeLessThan(profiles.indexOf('select count(*)'));
    expect(profiles).toContain('update public.accounts set updated_at = now()');
    expect(grants).toContain('update public.accounts set updated_at = now()');
    expect(profiles).toContain('commerce_entitlements_for(new.account_id)'); expect(profiles).toContain('Profile ownership is immutable');
  });
  it('protects suspension, immutable account identity and published plan terms', () => {
    expect(body('commerce_protect_account')).toContain('new.is_suspended is distinct from old.is_suspended');
    expect(body('commerce_protect_account')).toContain("public.has_permission('users.suspend')");
    expect(body('commerce_protect_account')).toContain('new.created_at is distinct from old.created_at');
    expect(body('commerce_protect_plan')).toContain('Published plan versions are immutable');
  });
  it('resolves expiry using database time and never grants perpetual/fake payment activation', () => {
    expect(body('commerce_entitlements_for')).toContain('s.access_until > now()');
    expect(body('commerce_entitlements_for')).toContain("'adFree', false");
    expect(body('commerce_manage_subscription')).toContain("Only admin-managed grant/revoke is supported");
    expect(body('commerce_manage_subscription')).toContain("interval '5 years'");
    expect(sql).toContain("check (source = 'admin_grant')");
  });
  it('blocks generic settings bypass, keeps VAST private and omits tag secrets from audits', () => {
    expect(body('commerce_protect_vast_setting')).toContain('VAST settings require the audited commerce service');
    expect(body('commerce_protect_vast_setting')).toContain('new.is_public');
    expect(body('commerce_save_vast')).toContain("v_before - 'tagUrl', p_config - 'tagUrl'");
    expect(sql).toContain('returns jsonb language sql stable security definer');
    expect(sql).toContain('select public.commerce_entitlements_for(auth.uid())');
  });
});
