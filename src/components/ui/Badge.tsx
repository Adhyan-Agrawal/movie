import { cn } from '@/lib/cn';

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'border-border bg-surface-raised/60 text-content-muted',
  primary: 'border-primary/40 bg-primary/15 text-primary',
  success: 'border-success/40 bg-success/15 text-success',
  warning: 'border-warning/40 bg-warning/15 text-warning',
  danger: 'border-danger/40 bg-danger/15 text-danger',
  info: 'border-info/40 bg-info/15 text-info',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-none tracking-wide',
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
