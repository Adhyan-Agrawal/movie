import type { CommerceActionState, CommercePlan } from './types';

export const commerceInputClass = 'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-content focus-visible:outline-primary';

export function formatPlanPrice(plan: Pick<CommercePlan, 'currency' | 'priceMinor'>): string {
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: plan.currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(plan.priceMinor / 10 ** digits);
}

export function CommerceCredentials() {
  return <div className="grid gap-4 sm:grid-cols-2">
    <label className="flex flex-col gap-1 text-sm">Audit reason
      <input name="reason" required minLength={5} maxLength={1000} className={commerceInputClass} placeholder="Why is this change needed?" />
    </label>
    <label className="flex flex-col gap-1 text-sm">Current admin password
      <input name="password" type="password" autoComplete="current-password" required maxLength={256} className={commerceInputClass} />
    </label>
  </div>;
}

export function CommerceFeedback({ state }: { state: CommerceActionState }) {
  return state.error ? <p role="alert" className="text-sm text-red-400">{state.error}</p> :
    state.ok ? <p role="status" className="text-sm text-green-400">Change saved and audited.</p> : null;
}
