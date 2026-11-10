'use client';

import { useActionState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { REQUEST_INITIAL_STATE, type TitleRequestState } from '../request-state';
import { submitTitleRequestAction } from '../requests-actions';

/** Shared field styling — mirrors SignUpForm / the admin sync panel. */
const fieldClass =
  'h-11 rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary';

/**
 * Request-a-title form (Spec Section 4). Client component using useActionState
 * for inline, accessible status display. Name is required; type defaults to
 * movie; year + note are optional. The action runs server-side under the
 * signed-in session, so nothing sensitive ships to the browser.
 */
export function RequestForm() {
  // React requests a form reset even when an action returns a validation error.
  const resetAllowed = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [state, formAction, pending] = useActionState<TitleRequestState, FormData>(
    async (previous, data) => {
      resetAllowed.current = false;
      try {
        const result = await submitTitleRequestAction(previous, data);
        resetAllowed.current = result.status === 'ok';
        return result;
      } catch {
        return { status: 'error', message: 'Could not submit your request. Please try again.' };
      }
    },
    REQUEST_INITIAL_STATE,
  );
  useEffect(() => {
    const form = formRef.current;
    // Reset runs during React's commit, while its delegated event handlers are disabled.
    const onReset = (event: Event) => { if (!resetAllowed.current) event.preventDefault(); };
    form?.addEventListener('reset', onReset);
    return () => form?.removeEventListener('reset', onReset);
  }, []);
  useEffect(() => { if (state.status === 'error') errorRef.current?.focus(); }, [state]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4" noValidate>
      {state.status === 'error' ? (
        <p ref={errorRef} role="alert" tabIndex={-1} className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {state.message}
        </p>
      ) : null}

      {state.status === 'ok' && state.message ? (
        <p role="status" className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
          {state.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="request-title-name" className="text-sm font-medium text-content">
          Title
        </label>
        <input
          id="request-title-name"
          name="title_name"
          disabled={pending}
          type="text"
          required
          autoComplete="off"
          className={fieldClass}
          placeholder="e.g. Dune: Part Two"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="request-media-type" className="text-sm font-medium text-content">
          Type
        </label>
        <select id="request-media-type" name="media_type" defaultValue="movie" disabled={pending} className={fieldClass}>
          <option value="movie">Movie</option>
          <option value="tv">Series</option>
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="request-year" className="text-sm font-medium text-content">
          Year <span className="font-normal text-content-muted">(optional)</span>
        </label>
        <input
          id="request-year"
          name="year"
          disabled={pending}
          type="number"
          min={1878}
          max={2100}
          placeholder="e.g. 2024"
          className={fieldClass}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="request-note" className="text-sm font-medium text-content">
          Note <span className="font-normal text-content-muted">(optional)</span>
        </label>
        <textarea
          id="request-note"
          name="note"
          disabled={pending}
          rows={3}
          className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary"
          placeholder="Anything that helps us find the right title — director, language, why you want it…"
        />
      </div>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Submitting…' : 'Request title'}
      </Button>

      <p className="text-center text-sm text-content-muted">
        It might already be here —{' '}
        <Link href="/search" className="text-primary hover:underline">
          search the catalog
        </Link>
      </p>
    </form>
  );
}
