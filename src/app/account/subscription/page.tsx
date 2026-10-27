import Link from 'next/link';
import { getViewerEntitlements } from '@/features/commerce/queries';
import { listCommercePlans, listCommerceSubscriptions } from '@/features/commerce/admin';
import { commerceIdentity } from '@/features/commerce/auth';
import { formatPlanPrice } from '@/features/commerce/CommerceFields';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Subscription' };

export default async function SubscriptionPage() {
  const identity = await commerceIdentity().catch(() => null);
  if (!identity?.user) return <div className="flex flex-col gap-3"><h2 className="text-xl font-semibold">Your subscription</h2>
    <p className="text-sm text-content-muted">Sign in to view your plan and access status.</p><Link className="text-primary hover:underline" href="/signin?next=/account/subscription">Sign in</Link></div>;
  const [entitlements, catalog, records] = await Promise.all([
    getViewerEntitlements(), listCommercePlans(), listCommerceSubscriptions(identity.user.id).catch(() => null),
  ]);
  return <div className="flex flex-col gap-8">
    <section className="rounded-lg border border-border bg-surface/40 p-5" aria-labelledby="subscription-heading">
      <h2 id="subscription-heading" className="text-xl font-semibold">Your subscription</h2>
      {!entitlements.resolved ? <p role="status" className="mt-3 text-sm text-content-muted">Your access status could not be verified. Advertising remains deferred while entitlement service is unavailable.</p> : <div className="mt-4 flex flex-col gap-2 text-sm">
        <p className="font-semibold">{entitlements.planName ?? 'Free access'} | {entitlements.status}</p>
        <p>{entitlements.adFree ? 'Ad-free viewing' : 'Advertising-supported viewing'} | Up to {entitlements.maxProfiles} profile{entitlements.maxProfiles === 1 ? '' : 's'}</p>
        {entitlements.accessUntil && <p>Access {entitlements.status === 'expired' ? 'expired' : 'until'} {new Date(entitlements.accessUntil).toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' })}</p>}
      </div>}
      <p className="mt-4 text-sm text-content-muted">Subscriptions are currently managed by an administrator. Online purchase, automatic renewal, and payment activation are not available.</p>
    </section>
    <section aria-labelledby="available-plans-heading" className="flex flex-col gap-4">
      <h3 id="available-plans-heading" className="text-lg font-semibold">Published plans</h3>
      {!catalog.plans.length && <p className="text-sm text-content-muted">{catalog.resolved ? 'No plans have been published.' : 'Plan information is temporarily unavailable.'}</p>}
      <div className="grid gap-4 sm:grid-cols-2">{catalog.plans.map((plan) => <article key={plan.id} className="rounded-lg border border-border bg-surface/40 p-5">
        <h4 className="font-semibold">{plan.name}</h4><p className="mt-2 text-sm text-content-muted">{plan.description}</p>
        <p className="mt-3 text-sm">{formatPlanPrice(plan)} / {plan.billingInterval} (listed price, not a checkout)</p>
        <p className="mt-2 text-sm">{plan.adFree ? 'No ads' : 'Advertising supported'} | {plan.maxProfiles} profiles</p>
        <ul className="mt-3 list-inside list-disc text-sm text-content-muted">{plan.features.map((feature, index) => <li key={index}>{feature}</li>)}</ul>
      </article>)}</div>
    </section>
    <section aria-labelledby="access-records-heading" className="flex flex-col gap-3">
      <h3 id="access-records-heading" className="text-lg font-semibold">Access records</h3>
      {records === null ? <p className="text-sm text-content-muted">Access records are temporarily unavailable.</p> : !records.length ? <p className="text-sm text-content-muted">No admin-managed grants on this account.</p> : records.map((record) => <div key={record.id} className="rounded border border-border p-4 text-sm">
        <p>{record.status === 'active' && Date.parse(record.accessUntil) <= Date.now() ? 'expired' : record.status} | Expires {new Date(record.accessUntil).toLocaleDateString('en-US', { timeZone: 'UTC' })}</p>
        <p className="mt-1 text-content-muted">Admin-managed access</p>
      </div>)}
    </section>
  </div>;
}
