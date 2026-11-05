import { cn } from '@/lib/cn';

/**
 * Single-colour film-frame mark. Geometry never waits on an image request.
 */
export function Logo({
  size = 28,
  className,
}: {
  size?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false" className={cn('lumora-mark shrink-0', className)}>
      <path d="M4 4h6v20h18v5H4V4Z" fill="currentColor" />
      <path d="m15 4 13 8-13 8V4Z" fill="currentColor" />
    </svg>
  );
}
