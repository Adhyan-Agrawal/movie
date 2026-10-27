'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { manageSubscriptionAction } from './actions';
import { CommerceCredentials, CommerceFeedback, commerceInputClass } from './CommerceFields';
import type { CommercePlan, CommerceSubscription } from './types';

export function SubscriptionManager({ plans }: { plans: CommercePlan[] }) {
  const [grantState, grantAction, grantPending] = useActionState(manageSubscriptionAction, { ok: false });
  const [revokeState, revokeAction, revokePending] = useActionState(manageSubscriptionAction, { ok: false });
  const [records, setRecords] = useState<CommerceSubscription[]>([]);
  const [lookupError, setLookupError] = useState('');
  const [loading, setLoading] = useState(false);
  const [grantExpiry, setGrantExpiry] = useState('');
  const published = plans.filter((plan) => plan.status === 'published');
  return <section className="flex flex-col gap-6" aria-labelledby="grants-heading">
    <div><h2 id="grants-heading" className="text-xl font-semibold">Admin-managed access</h2>
      <p className="mt-1 text-sm text-content-muted">Manual, expiring grants only. No charge, invoice, automatic renewal, or live payment activation occurs.</p></div>
    <form action={grantAction} className="flex flex-col gap-4 rounded-lg border border-border bg-surface/40 p-5">
      <input type="hidden" name="operation" value="grant" />
      <h3 className="font-semibold">Grant a published plan</h3>
      <label className="flex flex-col gap-1 text-sm">Account UUID<input name="accountId" required className={commerceInputClass} /></label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">Published plan version
          <select name="planId" required className={commerceInputClass} disabled={!published.length}>
            {published.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} v{plan.version}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">Access expires (your local time)
          <input type="datetime-local" required className={commerceInputClass} onChange={(event) => {
            const date = new Date(event.currentTarget.value);
            setGrantExpiry(Number.isFinite(date.getTime()) ? date.toISOString() : '');
          }} />
          <input type="hidden" name="accessUntil" value={grantExpiry} />
        </label>
      </div>
      {!published.length && <p className="text-sm text-content-muted">Publish a plan before granting access.</p>}
      <CommerceCredentials /><CommerceFeedback state={grantState} />
      <Button type="submit" disabled={grantPending || !published.length} className="self-start">{grantPending ? 'Granting...' : 'Grant timed access'}</Button>
    </form>
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface/40 p-5">
      <h3 className="font-semibold">Inspect account grants</h3>
      <form className="flex flex-col gap-3 sm:flex-row" onSubmit={async (event) => {
        event.preventDefault();
        const accountId = String(new FormData(event.currentTarget).get('accountId') ?? '').trim();
        setLoading(true); setLookupError(''); setRecords([]);
        try {
          const response = await fetch(`/api/account/subscription?accountId=${encodeURIComponent(accountId)}`, { cache: 'no-store' });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'Unable to read grants.');
          setRecords(body.subscriptions);
        } catch (error) { setLookupError(error instanceof Error ? error.message : 'Unable to read grants.'); }
        finally { setLoading(false); }
      }}>
        <label className="flex grow flex-col gap-1 text-sm">Account UUID<input name="accountId" required className={commerceInputClass} /></label>
        <Button type="submit" variant="secondary" disabled={loading} className="self-end">{loading ? 'Loading...' : 'Read grants'}</Button>
      </form>
      <p className="text-xs text-content-muted">Requires billing.read. Refresh this lookup after a grant or revocation.</p>
      {lookupError && <p role="alert" className="text-sm text-red-400">{lookupError}</p>}
      {records.map((record) => <div key={record.id} className="rounded border border-border p-3 text-sm">
        <p className="break-all font-mono text-xs">Grant {record.id}</p>
        <p>{record.status === 'active' && Date.parse(record.accessUntil) <= Date.now() ? 'expired' : record.status} | Until {new Date(record.accessUntil).toLocaleString()}</p>
        <p className="break-all text-xs text-content-muted">Plan {record.planId}</p><p className="mt-1">{record.reason}</p>
      </div>)}
    </div>
    <form action={revokeAction} className="flex flex-col gap-4 rounded-lg border border-border bg-surface/40 p-5">
      <input type="hidden" name="operation" value="revoke" /><h3 className="font-semibold">Revoke access</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">Account UUID<input name="accountId" required className={commerceInputClass} /></label>
        <label className="flex flex-col gap-1 text-sm">Grant UUID<input name="subscriptionId" required className={commerceInputClass} /></label>
      </div>
      <p className="text-sm text-content-muted">Revocation is immediate. Existing profiles are retained, but new profiles must fit the remaining entitlement limit.</p>
      <CommerceCredentials /><CommerceFeedback state={revokeState} />
      <Button type="submit" variant="secondary" disabled={revokePending} className="self-start">{revokePending ? 'Revoking...' : 'Revoke grant'}</Button>
    </form>
  </section>;
}
