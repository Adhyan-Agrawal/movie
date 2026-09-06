import Image from 'next/image';
import { cn } from '@/lib/cn';

/**
 * Brand logo (Spec Section 5 — brand identity). Rendered from /public/logo.png
 * via next/image so it is optimized per size; decorative by default — the
 * adjacent "Lumora" text (or the link's aria-label) carries the meaning.
 */
export function Logo({
  size = 28,
  className,
  priority = false,
}: {
  size?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/logo.png"
      alt=""
      width={size}
      height={size}
      priority={priority}
      className={cn('h-[1em] w-[1em] shrink-0 object-contain', className)}
      style={{ width: size, height: size }}
    />
  );
}
