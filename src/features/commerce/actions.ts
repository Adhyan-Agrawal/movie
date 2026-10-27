'use server';

import { revalidatePath } from 'next/cache';
import { CommerceError, mutateCommercePlan, mutateCommerceSubscription, saveVastConfiguration } from './admin';
import type { CommerceActionState } from './types';

function resultError(error: unknown): CommerceActionState {
  return { ok: false, error: error instanceof CommerceError ? error.message : 'Commerce is temporarily unavailable. No change was confirmed.' };
}

export async function managePlanAction(_state: CommerceActionState, form: FormData): Promise<CommerceActionState> {
  try {
    const operation = String(form.get('operation') ?? '');
    await mutateCommercePlan({
      operation, ...(form.get('id') ? { id: form.get('id') } : {}),
      ...(['create', 'update'].includes(operation) ? { plan: {
        slug: form.get('slug'), name: form.get('name'), description: form.get('description'), currency: form.get('currency'),
        priceMinor: Number(form.get('priceMinor')), billingInterval: form.get('billingInterval'),
        adFree: form.get('adFree') === 'on', maxProfiles: Number(form.get('maxProfiles')),
        features: String(form.get('features') ?? '').split('\n').map((feature) => feature.trim()).filter(Boolean),
      } } : {}), reason: form.get('reason'), password: form.get('password'),
    });
    revalidatePath('/admin/plans');
    revalidatePath('/account/subscription');
    return { ok: true };
  } catch (error) { return resultError(error); }
}

export async function manageSubscriptionAction(_state: CommerceActionState, form: FormData): Promise<CommerceActionState> {
  try {
    const until = String(form.get('accessUntil') ?? '');
    const expiry = until ? new Date(until) : null;
    if (expiry && !Number.isFinite(expiry.getTime())) throw new CommerceError('Invalid access expiry.', 400);
    await mutateCommerceSubscription({
      operation: form.get('operation'), accountId: form.get('accountId'),
      ...(form.get('planId') ? { planId: form.get('planId') } : {}),
      ...(form.get('subscriptionId') ? { subscriptionId: form.get('subscriptionId') } : {}),
      ...(expiry ? { accessUntil: expiry.toISOString() } : {}), reason: form.get('reason'), password: form.get('password'),
    });
    revalidatePath('/admin/plans');
    revalidatePath('/account/subscription');
    return { ok: true };
  } catch (error) { return resultError(error); }
}

export async function saveVastAction(_state: CommerceActionState, form: FormData): Promise<CommerceActionState> {
  try {
    await saveVastConfiguration({
      enabled: form.get('enabled') === 'on', tagUrl: form.get('tagUrl'),
      allowedHosts: String(form.get('allowedHosts') ?? '').split(/[\s,]+/).map((host) => host.trim().toLowerCase()).filter(Boolean),
      firstBreakSeconds: Number(form.get('firstBreakSeconds')), intervalSeconds: Number(form.get('intervalSeconds')),
      maxBreaks: Number(form.get('maxBreaks')), allowSkip: form.get('allowSkip') === 'on', skipAfterSeconds: Number(form.get('skipAfterSeconds')),
    }, form.get('reason'), form.get('password'));
    revalidatePath('/admin/ads');
    return { ok: true };
  } catch (error) { return resultError(error); }
}
