import { listCommercePlans, mutateCommercePlan } from '@/features/commerce/admin';
import { commerceFailure, commerceResponse, readCommerceMutation } from '@/features/commerce/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const admin = new URL(request.url).searchParams.get('admin') === '1';
    const result = await listCommercePlans(admin, request);
    return commerceResponse({ ...result, checkoutAvailable: false }, result.resolved ? 200 : 503);
  } catch (error) { return commerceFailure(error); }
}

async function mutate(request: Request) {
  try {
    const id = await mutateCommercePlan(await readCommerceMutation(request), request);
    return commerceResponse({ ok: true, id });
  } catch (error) { return commerceFailure(error); }
}

export const POST = mutate;
export const PATCH = mutate;
export const DELETE = mutate;
