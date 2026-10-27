import 'server-only';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { DEFAULT_VAST_CONFIGURATION, type PlaybackAdPolicy, type PlaybackCommerceContext, type ViewerEntitlements } from './types';
import { commerceIdentity } from './auth';
import { publicPlaybackPolicy, vastConfigurationSchema, viewerEntitlementsSchema } from './validation';

export const UNAVAILABLE_ENTITLEMENTS: ViewerEntitlements = { resolved: false, adFree: false, maxProfiles: 1, status: 'unavailable' };
const READ_TIMEOUT_MS = 2000;

export async function getViewerEntitlements(request?: Request): Promise<ViewerEntitlements> {
  // Never memoize this function: bearer and cookie accounts are request-local.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const identity = await Promise.race([
      commerceIdentity(request),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Identity timeout')), READ_TIMEOUT_MS); }),
    ]);
    const { data, error } = await identity.db.rpc('commerce_viewer_entitlements').abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
    if (error) return { ...UNAVAILABLE_ENTITLEMENTS };
    const parsed = viewerEntitlementsSchema.safeParse(data);
    return parsed.success ? parsed.data : { ...UNAVAILABLE_ENTITLEMENTS };
  } catch { return { ...UNAVAILABLE_ENTITLEMENTS }; }
  finally { if (timeout !== undefined) clearTimeout(timeout); }
}

export async function getVastConfiguration() {
  try {
    const { data, error } = await getSupabaseServiceClient().from('site_settings').select('value, is_public')
      .eq('key', 'playback_vast').abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS)).maybeSingle();
    if (error || !data || data.is_public) return { ...DEFAULT_VAST_CONFIGURATION, allowedHosts: [] };
    const parsed = vastConfigurationSchema.safeParse(data.value);
    return parsed.success ? parsed.data : { ...DEFAULT_VAST_CONFIGURATION, allowedHosts: [] };
  } catch { return { ...DEFAULT_VAST_CONFIGURATION, allowedHosts: [] }; }
}

// Only public scheduling is cached. Never cache a viewer, token, or provider tag.
let policyCache: { value: PlaybackAdPolicy; expiresAt: number } | undefined;
export function invalidatePlaybackPolicy() { policyCache = undefined; }
async function readPublicPolicy(): Promise<PlaybackAdPolicy> {
  if (policyCache && policyCache.expiresAt > Date.now()) return { ...policyCache.value };
  const value = publicPlaybackPolicy(await getVastConfiguration());
  policyCache = { value, expiresAt: Date.now() + 15000 };
  return { ...value };
}

export async function getPlaybackCommerceContext(request?: Request): Promise<PlaybackCommerceContext> {
  const [entitlements, ads] = await Promise.all([getViewerEntitlements(request), readPublicPolicy()]);
  return { entitlements, ads: { ...ads, enabled: ads.enabled && entitlements.resolved && !entitlements.adFree } };
}
