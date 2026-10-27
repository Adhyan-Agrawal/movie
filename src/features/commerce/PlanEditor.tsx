'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { managePlanAction } from './actions';
import { CommerceCredentials, CommerceFeedback, commerceInputClass } from './CommerceFields';
import type { CommercePlan } from './types';

export function PlanEditor({ plan, newVersion = false }: { plan?: CommercePlan; newVersion?: boolean }) {
  const [state, action, pending] = useActionState(managePlanAction, { ok: false });
  const operation = plan && !newVersion ? 'update' : 'create';
  return <form action={action} className="flex flex-col gap-4">
    <input type="hidden" name="operation" value={operation} />
    {operation === 'update' && <input type="hidden" name="id" value={plan!.id} />}
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">Plan slug
        <input name="slug" defaultValue={plan?.slug} readOnly={!!plan} required pattern="[a-z0-9][a-z0-9-]{1,63}" maxLength={64} placeholder="premium" className={commerceInputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Display name
        <input name="name" defaultValue={plan?.name} required maxLength={100} className={commerceInputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Currency (ISO 4217)
        <input name="currency" defaultValue={plan?.currency ?? 'USD'} required pattern="[A-Z]{3}" maxLength={3} className={commerceInputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Price in integer minor units
        <input name="priceMinor" type="number" defaultValue={plan?.priceMinor ?? 0} min={0} max={100000000} step={1} required className={commerceInputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Billing interval (metadata only)
        <select name="billingInterval" defaultValue={plan?.billingInterval ?? 'month'} className={commerceInputClass}>
          <option value="month">Monthly</option><option value="year">Yearly</option><option value="one_time">One-time</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Maximum profiles
        <input name="maxProfiles" type="number" defaultValue={plan?.maxProfiles ?? 1} min={1} max={20} step={1} required className={commerceInputClass} />
      </label>
    </div>
    <label className="flex items-center gap-2 text-sm"><input name="adFree" type="checkbox" defaultChecked={plan?.adFree ?? false} />No advertising</label>
    <label className="flex flex-col gap-1 text-sm">Description
      <textarea name="description" defaultValue={plan?.description ?? ''} maxLength={2000} rows={2} className={commerceInputClass} />
    </label>
    <label className="flex flex-col gap-1 text-sm">Features (one per line, up to 30)
      <textarea name="features" defaultValue={plan?.features.join('\n') ?? ''} maxLength={4830} rows={3} className={commerceInputClass} />
    </label>
    <CommerceCredentials /><CommerceFeedback state={state} />
    <Button type="submit" disabled={pending} className="self-start">{pending ? 'Saving...' : operation === 'update' ? 'Save draft' : newVersion ? 'Create new draft version' : 'Create draft plan'}</Button>
  </form>;
}

export function PlanLifecycle({ plan }: { plan: CommercePlan }) {
  const [state, action, pending] = useActionState(managePlanAction, { ok: false });
  if (plan.status === 'archived') return null;
  return <form action={action} className="flex flex-col gap-4 border-t border-border pt-4">
    <input type="hidden" name="id" value={plan.id} />
    <label className="flex flex-col gap-1 text-sm">Version action
      <select name="operation" className={commerceInputClass} defaultValue={plan.status === 'draft' ? 'publish' : 'archive'}>
        {plan.status === 'draft' && <option value="publish">Publish saved draft (supersedes the previous version)</option>}
        <option value="archive">Archive (existing grants keep their terms)</option>
        {plan.status === 'draft' && <option value="delete">Delete draft permanently</option>}
      </select>
    </label>
    <CommerceCredentials /><CommerceFeedback state={state} />
    <Button type="submit" variant="secondary" disabled={pending} className="self-start">{pending ? 'Applying...' : 'Apply version action'}</Button>
  </form>;
}
