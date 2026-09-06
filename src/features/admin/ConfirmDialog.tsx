'use client';

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

/**
 * Accessible confirmation modal for reversible/destructive actions (Section 0).
 *
 * Implements: role="dialog" + aria-modal, labelled + described by ids, initial
 * focus, a Tab/Shift+Tab focus trap, Escape to cancel, backdrop click to cancel,
 * background scroll lock, and focus restoration to the trigger on close.
 */

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  /** Disable the confirm button (e.g. while a request would be in flight). */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const title_id = useId();
  const desc_id = useId();

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Prefer the confirm button as the initial focus target.
    const raf = requestAnimationFrame(() => confirmRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const node = dialogRef.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, onCancel]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={onCancel}
        className="absolute inset-0 bg-base/70 backdrop-blur-sm animate-fade-in"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title_id}
        aria-describedby={description ? desc_id : undefined}
        className={cn(
          'relative z-10 w-full max-w-md rounded-lg border border-border-strong bg-surface-overlay p-5 shadow-raised',
          'animate-fade-in',
        )}
      >
        <h2 id={title_id} className="font-display text-lg font-semibold">
          {title}
        </h2>
        {description ? (
          <p id={desc_id} className="mt-2 text-sm text-content-muted">
            {description}
          </p>
        ) : null}
        {children ? <div className="mt-3">{children}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant="primary"
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            className={tone === 'danger' ? 'bg-danger text-white hover:bg-danger/90' : undefined}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
