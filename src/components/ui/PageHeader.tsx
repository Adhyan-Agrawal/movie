import { cn } from '@/lib/cn';

/** Consistent page title + optional description and actions (Section 5). */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('site-page-header', className)}>
      <div className="min-w-0">
        <h1 className="site-page-title">{title}</h1>
        {description ? <p className="mt-3 max-w-2xl text-sm leading-relaxed text-content-muted md:text-base">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
