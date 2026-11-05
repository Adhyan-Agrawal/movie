import { cn } from '@/lib/cn';

/** Centered page container with consistent gutters (Section 5 layout). */
export function Container({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('site-container', className)}>{children}</div>;
}
