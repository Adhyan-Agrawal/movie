import { PageHeader } from '@/components/ui/PageHeader';
import { listCommercePlans } from '@/features/commerce/admin';
import { PlanEditor, PlanLifecycle } from '@/features/commerce/PlanEditor';
import { SubscriptionManager } from '@/features/commerce/SubscriptionManager';
import { formatPlanPrice } from '@/features/commerce/CommerceFields';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Plans and access' };

export default async function AdminPlansPage() {
  const result = await listCommercePlans(true).catch(() => null);
  if (!result) return <p role="alert" className="py-6">Access restricted. The plans.manage permission and a verified, non-suspended account are required.</p>;
  return <div className="flex flex-col gap-8 py-6">
    <PageHeader title="Plans and access" description="Versioned plan metadata and audited, expiring admin-managed subscriptions." />
    <p className="rounded-lg border border-border p-4 text-sm text-content-muted">Payment provider not selected. Prices describe plans only; this console does not charge users or enable live payments. Published versions are immutable, and new versions do not change existing grants.</p>
    {!result.resolved && <p role="alert" className="text-sm text-red-400">Commerce storage is unavailable. Prepare migration 0010_commerce.sql for an approved release before saving plans or grants.</p>}
    <section className="flex flex-col gap-4" aria-labelledby="new-plan-heading">
      <h2 id="new-plan-heading" className="text-xl font-semibold">Create a plan</h2>
      <div className="rounded-lg border border-border bg-surface/40 p-5"><PlanEditor /></div>
    </section>
    <section className="flex flex-col gap-4" aria-labelledby="versions-heading">
      <h2 id="versions-heading" className="text-xl font-semibold">Plan versions</h2>
      {!result.plans.length && <p className="text-sm text-content-muted">No plan versions are available.</p>}
      {result.plans.map((plan) => <article key={plan.id} className="flex flex-col gap-4 rounded-lg border border-border bg-surface/40 p-5">
        <div><h3 className="font-semibold">{plan.name} <span className="text-content-muted">v{plan.version} | {plan.status}</span></h3>
          <p className="mt-1 break-all font-mono text-xs text-content-muted">{plan.slug} | {plan.id}</p></div>
        <p className="text-sm">{formatPlanPrice(plan)} / {plan.billingInterval} | {plan.adFree ? 'No ads' : 'Advertising supported'} | {plan.maxProfiles} profiles</p>
        <p className="text-sm text-content-muted">{plan.description}</p>
        <details className="rounded border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{plan.status === 'draft' ? 'Edit draft' : 'Create a new draft from this version'}</summary>
          <div className="pt-4"><PlanEditor plan={plan} newVersion={plan.status !== 'draft'} /></div>
        </details>
        <PlanLifecycle plan={plan} />
      </article>)}
    </section>
    <SubscriptionManager plans={result.plans} />
  </div>;
}
