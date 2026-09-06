'use client';

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * Accessible confirmation modal for destructive actions (Section 0). Provides
 * role="dialog" + aria-modal, a focus trap, Escape-to-close, a click-away
 * backdrop, scroll lock, and focus restoration to the trigger on close.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    // Focus the least-destructive action once the portal is painted.
    const raf = requestAnimationFrame(() => cancelRef.current?.focus());
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusables = getFocusable(panelRef.current);
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        onKeyDown={onKeyDown}
        className="relative w-full max-w-md rounded-lg border border-border bg-surface-overlay p-6 shadow-raised animate-fade-in"
      >
        <div className="flex items-start gap-3">
          {tone === 'danger' ? (
            <span
              aria-hidden="true"
              className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-danger/15 text-lg font-bold text-danger"
            >
              !
            </span>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <h2 id={titleId} className="text-lg font-semibold text-content">
              {title}
            </h2>
            {description ? (
              <div id={descId} className="text-sm text-content-muted">
                {description}
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button ref={cancelRef} type="button" className={buttonClasses({ variant: 'secondary' })} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={cn(
              buttonClasses({ variant: 'primary' }),
              tone === 'danger' && 'bg-danger text-white hover:bg-danger/90',
            )}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
