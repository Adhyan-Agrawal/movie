'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { EMAIL_SETTINGS_INITIAL_STATE, type EmailSettingsState } from './email-settings-state';
import { saveEmailSettingsAction, sendTestEmailAction } from './email-settings-actions';

/**
 * Admin SMTP / email settings panel (Spec Section 10).
 *
 * Two independent server actions, each with its own useActionState:
 *  - Save — upserts the `smtp.*` rows in `site_settings` (permission-gated
 *    `settings.manage`). The password input is write-only: the current value
 *    is never loaded into the form, and a blank submit keeps the stored one.
 *  - Test — sends a test message through the stored relay and reports the
 *    transport's verdict (success or the raw failure) so a bad host/auth is
 *    diagnosable.
 *
 * `initial` is read server-side (see the page) and passed in; only non-secret
 * values cross the boundary — `hasPassword` is just a hint flag.
 */

/** Non-secret SMTP values passed from the server page. */
export interface EmailSettingsInitialValues {
  host: string;
  port: string;
  user: string;
  from: string;
  /** True when a password is already stored — the form keeps it on blank submit. */
  hasPassword: boolean;
}

const inputClasses =
  'h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-sm text-content ' +
  'placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary';

const fieldLabelClasses = 'text-sm font-medium text-content';

/** Success banner. */
function OkBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="rounded-md border border-success/40 bg-success/10 px-4 py-3 text-sm text-success"
    >
      {message}
    </div>
  );
}

/** Error banner. */
function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger"
    >
      {message}
    </p>
  );
}

export function EmailSettingsPanel({ initial }: { initial: EmailSettingsInitialValues }) {
  const [saveState, saveAction, saving] = useActionState<EmailSettingsState, FormData>(
    saveEmailSettingsAction,
    EMAIL_SETTINGS_INITIAL_STATE,
  );
  const [testState, testAction, testing] = useActionState<EmailSettingsState, FormData>(
    sendTestEmailAction,
    EMAIL_SETTINGS_INITIAL_STATE,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-2xl flex-col gap-2">
        <h2 className="text-lg font-semibold text-content">SMTP relay</h2>
        <p className="text-sm leading-relaxed text-content-muted">
          Credentials are stored in <code className="font-mono">site_settings</code> (keys <code className="font-mono">smtp.*</code>)
          and used server-side when Lumora sends mail. They are internal — never exposed to the public — and the
          password is write-only: it is never sent back to this form.
        </p>
      </div>

      {/* Save form */}
      <form action={saveAction} className="flex max-w-2xl flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email-host" className={fieldLabelClasses}>
            SMTP host
          </label>
          <input
            id="email-host"
            name="host"
            type="text"
            defaultValue={initial.host}
            placeholder="e.g. smtp.gmail.com"
            autoComplete="off"
            className={inputClasses}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="email-port" className={fieldLabelClasses}>
            Port
          </label>
          <input
            id="email-port"
            name="port"
            type="number"
            min={1}
            max={65535}
            defaultValue={initial.port}
            placeholder="e.g. 587"
            className={inputClasses}
          />
          <p className="text-xs text-content-subtle">Port 465 uses implicit TLS; other ports upgrade to STARTTLS.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="email-user" className={fieldLabelClasses}>
            Username
          </label>
          <input
            id="email-user"
            name="user"
            type="text"
            defaultValue={initial.user}
            autoComplete="username"
            className={inputClasses}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="email-password" className={fieldLabelClasses}>
            Password
          </label>
          <input
            id="email-password"
            name="password"
            type="password"
            defaultValue=""
            autoComplete="new-password"
            placeholder={initial.hasPassword ? '••••••••' : ''}
            className={inputClasses}
          />
          <p className="text-xs text-content-subtle">
            {initial.hasPassword
              ? 'Leave blank to keep the existing password.'
              : 'Required the first time — after that, leave blank to keep it unchanged.'}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="email-from" className={fieldLabelClasses}>
            From address
          </label>
          <input
            id="email-from"
            name="from"
            type="email"
            defaultValue={initial.from}
            placeholder="e.g. no-reply@lumora.example"
            autoComplete="off"
            className={inputClasses}
          />
          <p className="text-xs text-content-subtle">
            Shown as the sender on every message Lumora sends (and the recipient of test emails).
          </p>
        </div>

        <div>
          <Button type="submit" disabled={saving || testing} size="lg">
            {saving ? 'Saving…' : 'Save email settings'}
          </Button>
        </div>

        {saveState.status === 'ok' ? <OkBanner message={saveState.message} /> : null}
        {saveState.status === 'error' ? <ErrorBanner message={saveState.message} /> : null}
      </form>

      {/* Test form — separate action, so the two statuses never clobber each other */}
      <form action={testAction} className="flex max-w-2xl flex-col gap-2">
        <div>
          <Button type="submit" variant="secondary" disabled={testing || saving} size="lg">
            {testing ? 'Sending…' : 'Send test email'}
          </Button>
        </div>
        <p className="text-xs text-content-subtle">
          Sends a message to the configured from address through the saved relay — useful to verify a config change
          without waiting for real mail.
        </p>
        {testState.status === 'ok' ? <OkBanner message={testState.message} /> : null}
        {testState.status === 'error' ? <ErrorBanner message={testState.message} /> : null}
      </form>
    </div>
  );
}
