import { sameOriginPlaybackUrl } from '../lib/api';
import { supabase } from '../lib/supabase';
import type { ViewerEntitlements } from '../lib/types';

export async function fetchAdMobEntitlements(signal?: AbortSignal): Promise<{
  accountId: string; entitlements: ViewerEntitlements | null;
} | null> {
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 8000);
  signal?.addEventListener('abort', abort, { once: true });
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      (async () => {
        const { data, error } = await supabase.auth.getSession();
        const session = data.session;
        if (error || !session?.user.id || !session.access_token || controller.signal.aborted) return null;
        const url = sameOriginPlaybackUrl('/api/account/subscription');
        if (!url || new URL(url).protocol !== 'https:') return null;
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'error',
          headers: { Authorization: `Bearer ${session.access_token}` } });
        if (controller.signal.aborted) return null;
        if (!response.ok) return { accountId: session.user.id, entitlements: null };
        const body = await response.json() as { entitlements?: ViewerEntitlements };
        if (controller.signal.aborted) return null;
        const e = body.entitlements;
        const valid = e?.resolved === true && typeof e.adFree === 'boolean'
          && ['free', 'active', 'expired'].includes(e.status) && Number.isInteger(e.maxProfiles) && e.maxProfiles >= 1;
        return { accountId: session.user.id, entitlements: valid ? { resolved: true, adFree: e!.adFree,
          maxProfiles: e!.maxProfiles, status: e!.status } : null };
      })(),
      new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) resolve(null);
      }),
    ]);
  } catch { return null; } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
  }
}
