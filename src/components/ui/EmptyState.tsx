import { cn } from '@/lib/cn';

/**
 * Reusable empty / error / offline / unauthorized states (Section 0: every
 * feature needs these). Neutral by default; `tone` shifts the accent.
 */
export function EmptyState({
  icon = '◇',
  title,
  description,
  action,
  tone = 'neutral',
  className,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  tone?: 'neutral' | 'danger' | 'warning';
  className?: string;
}) {
  const accent =
    tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-content-subtle';
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border',
        'bg-surface/40 px-6 py-16 text-center',
        className,
      )}
    >
      <div aria-hidden="true" className={cn('text-3xl', accent)}>
        {icon}
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? <p className="max-w-sm text-sm text-content-muted">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
