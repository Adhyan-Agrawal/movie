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
        'site-empty-state flex flex-col items-center justify-center gap-4 border border-border',
        'bg-surface px-6 py-16 text-center',
        className,
      )}
    >
      <div aria-hidden="true" className={cn('grid h-12 w-12 place-items-center rounded-full border border-border text-2xl', accent)}>
        {icon}
      </div>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {description ? <p className="max-w-md text-sm leading-relaxed text-content-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
