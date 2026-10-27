import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { publicEnv } from '@/lib/env';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import type { Database, Json, Tables } from '@/lib/supabase/types';
import { PERMISSIONS, type Permission } from '@/lib/permissions/permissions';
import { commerceIdentity } from './auth';
import { commerceReasonSchema, planInputSchema, vastConfigurationSchema } from './validation';
import { invalidatePlaybackPolicy } from './queries';
import type { CommercePlan, CommerceSubscription } from './types';
import { z } from 'zod';

export class CommerceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function requireCommercePermission(permission: Permission, request?: Request) {
  let identity;
  try { identity = await commerceIdentity(request); } catch { throw new CommerceError('Authentication unavailable.', 401); }
  if (!identity.user) throw new CommerceError('Sign in to continue.', 401);
  const [permissionResult, accountResult] = await Promise.all([
    identity.db.rpc('has_permission', { perm_key: permission }).abortSignal(AbortSignal.timeout(3000)),
    identity.db.from('accounts').select('is_suspended').eq('id', identity.user.id)
      .abortSignal(AbortSignal.timeout(3000)).maybeSingle(),
  ]);
  if (permissionResult.error || !permissionResult.data || accountResult.error || !accountResult.data || accountResult.data.is_suspended) {
    throw new CommerceError(`Missing required permission: ${permission}`, 403);
  }
  return identity;
}

async function reauthenticate(permission: Permission, password: unknown, request?: Request) {
  const identity = await requireCommercePermission(permission, request);
  const parsed = z.string().min(1).max(256).safeParse(password);
  if (!parsed.success || !identity.user.email) throw new CommerceError('Your current password is required for this change.', 400);
  // Isolated client: do not replace request cookies, store a session or log credentials.
  const verification = createClient<Database>(publicEnv.NEXT_PUBLIC_SUPABASE_URL!, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await verification.auth.signInWithPassword({ email: identity.user.email, password: parsed.data });
  if (data.session) await verification.auth.signOut({ scope: 'local' });
  if (error || data.user?.id !== identity.user.id) throw new CommerceError('Password verification failed.', 403);
  return identity.user.id;
}

export function planDto(row: Tables<'commerce_plans'>): CommercePlan {
  return { id: row.id, slug: row.slug, version: row.version, name: row.name, description: row.description,
    currency: row.currency, priceMinor: row.price_minor, billingInterval: row.billing_interval,
    adFree: row.ad_free, maxProfiles: row.max_profiles,
    features: Array.isArray(row.features) ? row.features.filter((feature): feature is string => typeof feature === 'string') : [],
    status: row.status, publishedAt: row.published_at };
}

export async function listCommercePlans(admin = false, request?: Request): Promise<{ resolved: boolean; plans: CommercePlan[] }> {
  if (admin) await requireCommercePermission(PERMISSIONS.PLANS_MANAGE, request);
  try {
    // A separate anon client prevents cookie-dependent public plan results.
    const db = admin ? getSupabaseServiceClient() : createClient<Database>(publicEnv.NEXT_PUBLIC_SUPABASE_URL!, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    let query = db.from('commerce_plans').select('*').order('slug').order('version', { ascending: false }).limit(200);
    if (!admin) query = query.eq('status', 'published');
    const { data, error } = await query.abortSignal(AbortSignal.timeout(3000));
    if (error) return { resolved: false, plans: [] };
    return { resolved: true, plans: (data ?? []).map(planDto) };
  } catch { return { resolved: false, plans: [] }; }
}

export async function listCommerceSubscriptions(accountId: string, admin = false, request?: Request): Promise<CommerceSubscription[]> {
  const parsed = z.string().uuid().safeParse(accountId);
  if (!parsed.success) throw new CommerceError('Invalid account ID.', 400);
  const identity = admin ? await requireCommercePermission(PERMISSIONS.BILLING_READ, request) : await commerceIdentity(request);
  if (!identity.user || (!admin && identity.user.id !== accountId)) throw new CommerceError('Sign in to view subscriptions.', 401);
  const { data, error } = await identity.db.from('commerce_subscriptions').select('*').eq('account_id', accountId)
    .order('created_at', { ascending: false }).limit(100).abortSignal(AbortSignal.timeout(3000));
  if (error) throw new CommerceError('Subscription records are unavailable. The commerce migration may not be installed.', 503);
  return (data ?? []).map((row) => ({ id: row.id, accountId: row.account_id, planId: row.plan_id,
    status: row.status, startsAt: row.starts_at, accessUntil: row.access_until, reason: row.reason, source: row.source }));
}

export const planMutationSchema = z.object({
  operation: z.enum(['create', 'update', 'publish', 'archive', 'delete']),
  id: z.string().uuid().optional(), plan: planInputSchema.optional(),
  reason: commerceReasonSchema, password: z.string().min(1).max(256),
}).strict().superRefine((input, ctx) => {
  if (input.operation !== 'create' && !input.id) ctx.addIssue({ code: 'custom', path: ['id'], message: 'A plan ID is required.' });
  if (['create', 'update'].includes(input.operation) && !input.plan) ctx.addIssue({ code: 'custom', path: ['plan'], message: 'Plan details are required.' });
});

export async function mutateCommercePlan(input: unknown, request?: Request) {
  const parsed = planMutationSchema.safeParse(input);
  if (!parsed.success) throw new CommerceError(parsed.error.issues[0]?.message ?? 'Invalid plan.', 400);
  const value = parsed.data;
  const actor = await reauthenticate(PERMISSIONS.PLANS_MANAGE, value.password, request);
  const { data, error } = await getSupabaseServiceClient().rpc('commerce_manage_plan', {
    p_actor: actor, p_operation: value.operation, p_id: value.id ?? null,
    p_payload: (value.plan ?? {}) as Json, p_reason: value.reason,
  });
  if (error) throw new CommerceError('Plan change was not saved. Check its version state and commerce migration.', 409);
  return data;
}

export const subscriptionMutationSchema = z.object({
  operation: z.enum(['grant', 'revoke']), accountId: z.string().uuid(), planId: z.string().uuid().optional(),
  subscriptionId: z.string().uuid().optional(), accessUntil: z.string().datetime({ offset: true }).optional(),
  reason: commerceReasonSchema, password: z.string().min(1).max(256),
}).strict().superRefine((input, ctx) => {
  if (input.operation === 'grant' && (!input.planId || !input.accessUntil || Date.parse(input.accessUntil) <= Date.now() ||
    Date.parse(input.accessUntil) > Date.now() + 5 * 366 * 86400000)) {
    ctx.addIssue({ code: 'custom', message: 'Grant needs a published plan and an expiry within five years.' });
  }
  if (input.operation === 'revoke' && !input.subscriptionId) ctx.addIssue({ code: 'custom', message: 'A subscription ID is required.' });
});

export async function mutateCommerceSubscription(input: unknown, request?: Request) {
  const parsed = subscriptionMutationSchema.safeParse(input);
  if (!parsed.success) throw new CommerceError(parsed.error.issues[0]?.message ?? 'Invalid grant.', 400);
  const value = parsed.data;
  const actor = await reauthenticate(PERMISSIONS.PLANS_MANAGE, value.password, request);
  const { data, error } = await getSupabaseServiceClient().rpc('commerce_manage_subscription', {
    p_actor: actor, p_operation: value.operation, p_account: value.accountId, p_plan: value.planId ?? null,
    p_subscription: value.subscriptionId ?? null, p_access_until: value.accessUntil ?? null, p_reason: value.reason,
  });
  if (error) throw new CommerceError('Grant change was not saved. Check the account, published plan, and commerce migration.', 409);
  return data;
}

export async function saveVastConfiguration(config: unknown, reason: unknown, password: unknown) {
  const parsed = vastConfigurationSchema.safeParse(config);
  const parsedReason = commerceReasonSchema.safeParse(reason);
  if (!parsed.success || !parsedReason.success) throw new CommerceError(
    !parsed.success ? parsed.error.issues[0]?.message ?? 'Invalid VAST configuration.' : 'An audit reason is required.', 400);
  const actor = await reauthenticate(PERMISSIONS.ADS_MANAGE, password);
  const { error } = await getSupabaseServiceClient().rpc('commerce_save_vast', {
    p_actor: actor, p_config: parsed.data as Json, p_reason: parsedReason.data,
  });
  if (error) throw new CommerceError('VAST settings were not saved. Ensure the commerce migration is installed.', 503);
  invalidatePlaybackPolicy();
}
