'use client';

import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name announced by screen readers (`aria-label`). */
  label: string;
  id?: string;
  disabled?: boolean;
}

/**
 * Accessible toggle built on a `role="switch"` button (Section 5). The hit
 * area is a 44px square so it meets the target-size guidance even though the
 * visible track is smaller. Keyboard support is native (Space/Enter).
 */
export function Switch({ checked, onChange, label, id, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'group inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md',
        'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      <span
        className={cn(
          'relative h-6 w-11 rounded-full border transition-colors duration-150 ease-deliberate',
          checked ? 'border-primary bg-primary' : 'border-border-strong bg-surface-raised',
        )}
      >
        <span
          className={cn(
            'absolute left-0.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow-soft',
            'transition-transform duration-150 ease-deliberate',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </span>
    </button>
  );
}
