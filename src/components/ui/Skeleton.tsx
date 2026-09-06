import { cn } from '@/lib/cn';

/** Shimmer placeholder that reserves layout to avoid CLS (Section 16). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative overflow-hidden rounded-md bg-surface-raised',
        'before:absolute before:inset-0 before:-translate-x-full',
        'before:animate-shimmer before:bg-gradient-to-r',
        'before:from-transparent before:via-white/5 before:to-transparent',
        className,
      )}
    />
  );
}
