import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

const variantClasses: Record<Variant, string> = {
  primary: 'bg-primary text-primary-contrast hover:bg-primary-hover font-semibold',
  secondary: 'bg-surface-raised text-content border border-border-strong hover:bg-surface-overlay',
  ghost: 'text-content-muted hover:text-content hover:bg-surface-raised/60',
};

const sizeClasses: Record<Size, string> = {
  // Meets the 44px minimum target guidance (Section 5) at md/lg.
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-11 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

const baseClasses =
  'inline-flex items-center justify-center rounded-md transition-colors duration-150 ' +
  'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';

/** Shared class builder so links can be styled as buttons (Next <Link>). */
export function buttonClasses(opts?: { variant?: Variant; size?: Size; className?: string }): string {
  const { variant = 'primary', size = 'md', className } = opts ?? {};
  return cn(baseClasses, variantClasses[variant], sizeClasses[size], className);
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, type = 'button', ...props },
  ref,
) {
  return <button ref={ref} type={type} className={buttonClasses({ variant, size, className })} {...props} />;
});
