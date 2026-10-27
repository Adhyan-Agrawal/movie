import { commerceIdentity } from '@/features/commerce/auth';
import { CommerceError, listCommerceSubscriptions, mutateCommerceSubscription } from '@/features/commerce/admin';
import { getViewerEntitlements } from '@/features/commerce/queries';
import { commerceFailure, commerceResponse, readCommerceMutation } from '@/features/commerce/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const accountId = new URL(request.url).searchParams.get('accountId');
    if (accountId) return commerceResponse({ subscriptions: await listCommerceSubscriptions(accountId, true, request) });
    const identity = await commerceIdentity(request);
    if (!identity.user) throw new CommerceError('Sign in to view your subscription.', 401);
    const entitlements = await getViewerEntitlements(request);
    // Entitlements alone remain useful while records are unavailable; never invent activation.
    return commerceResponse({ entitlements, checkoutAvailable: false }, entitlements.resolved ? 200 : 503);
  } catch (error) { return commerceFailure(error); }
}

export async function POST(request: Request) {
  try {
    const id = await mutateCommerceSubscription(await readCommerceMutation(request), request);
    return commerceResponse({ ok: true, id });
  } catch (error) { return commerceFailure(error); }
}
