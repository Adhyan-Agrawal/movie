import { cn } from '@/lib/cn';

/** Centered page container with consistent gutters (Section 5 layout). */
export function Container({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('mx-auto w-full max-w-7xl px-4 md:px-8', className)}>{children}</div>;
}
