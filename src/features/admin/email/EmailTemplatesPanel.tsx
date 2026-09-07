'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import type { EmailTemplate, EmailTemplateId } from './templates';
import { saveEmailTemplatesAction, sendTestTemplateAction } from './templates-actions';
import { TEMPLATE_ACTION_INITIAL_STATE, type TemplateActionState } from './templates-state';

/**
 * Admin email-templates panel (Spec Section 10).
 *
 * A tab per transactional template; editing is plain textareas (no rich
 * editor). Each template saves independently through
 * `saveEmailTemplatesAction` (permission-gated `settings.manage`), and a
 * "Send test" button renders the template with sample variables and sends it
 * to the signed-in admin's email through the configured SMTP relay.
 *
 * `templates` is the EFFECTIVE set (built-ins merged with stored overrides),
 * loaded server-side by the page; `adminEmail` is the signed-in admin's
 * address, so the test button has a recipient without another lookup.
 */

export interface EmailTemplatesPanelProps {
  templates: Record<EmailTemplateId, EmailTemplate>;
  adminEmail: string;
}

/** Every placeholder the default template copy can reference. */
const AVAILABLE_VARIABLES = ['{{name}}', '{{title}}', '{{link}}'];

const inputClasses =
  'w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-content ' +
  'placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary';

const fieldLabelClasses = 'text-sm font-medium text-content';

interface Draft {
  subject: string;
  bodyHtml: string;
  bodyText: string;
}

/** Turn a template id into a friendly tab label ("password_reset" → "Password reset"). */
function templateLabel(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function OkBanner({ message }: { message: string }) {
  return (
    <div role="status" className="rounded-md border border-success/40 bg-success/10 px-4 py-3 text-sm text-success">
      {message}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger">
      {message}
    </p>
  );
}

export function EmailTemplatesPanel({ templates, adminEmail }: EmailTemplatesPanelProps) {
  const ids = Object.keys(templates) as EmailTemplateId[];
  const [selectedId, setSelectedId] = useState<EmailTemplateId>(ids[0] ?? 'welcome');
  const current = templates[selectedId];
  const [draft, setDraft] = useState<Draft>({
    subject: current?.subject ?? '',
    bodyHtml: current?.bodyHtml ?? '',
    bodyText: current?.bodyText ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<TemplateActionState>(TEMPLATE_ACTION_INITIAL_STATE);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TemplateActionState>(TEMPLATE_ACTION_INITIAL_STATE);

  // The page always passes the full 6-template record; guard keeps TS honest.
  if (!current) return null;

  function selectTemplate(id: EmailTemplateId) {
    setSelectedId(id);
    const tpl = templates[id];
    if (tpl) setDraft({ subject: tpl.subject, bodyHtml: tpl.bodyHtml, bodyText: tpl.bodyText });
    setSaveResult(TEMPLATE_ACTION_INITIAL_STATE);
    setTestResult(TEMPLATE_ACTION_INITIAL_STATE);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = JSON.stringify({
        [selectedId]: {
          id: selectedId,
          subject: draft.subject,
          bodyHtml: draft.bodyHtml,
          bodyText: draft.bodyText,
          description: current.description,
        },
      });
      setSaveResult(await saveEmailTemplatesAction(payload));
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTest() {
    setTesting(true);
    try {
      setTestResult(await sendTestTemplateAction(selectedId, adminEmail));
    } finally {
      setTesting(false);
    }
  }

  const dirty = draft.subject !== current.subject || draft.bodyHtml !== current.bodyHtml || draft.bodyText !== current.bodyText;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-3xl flex-col gap-2">
        <h2 className="text-lg font-semibold text-content">Transactional email templates</h2>
        <p className="text-sm leading-relaxed text-content-muted">
          Copy for every automated email Lumora sends. Overrides are stored in{' '}
          <code className="font-mono">site_settings</code> (key <code className="font-mono">email.templates</code>);
          built-in defaults fill in anything you have not customized.
        </p>
      </div>

      {/* Template picker */}
      <div role="group" aria-label="Email template" className="flex flex-wrap gap-2">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={selectedId === id}
            onClick={() => selectTemplate(id)}
            className={cn(
              'h-11 rounded-md border px-4 text-sm transition-colors duration-150 ease-deliberate',
              selectedId === id
                ? 'border-border-strong bg-surface-overlay font-medium text-content'
                : 'border-border bg-surface-raised/60 text-content-muted hover:text-content',
            )}
          >
            {templateLabel(id)}
          </button>
        ))}
      </div>

      {/* Editor for the selected template */}
      <div className="flex max-w-3xl flex-col gap-4">
        <p className="text-sm text-content-muted">{current.description}</p>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="tpl-subject" className={fieldLabelClasses}>
            Subject
          </label>
          <input
            id="tpl-subject"
            type="text"
            value={draft.subject}
            onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
            className={inputClasses}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="tpl-html" className={fieldLabelClasses}>
            HTML body
          </label>
          <textarea
            id="tpl-html"
            value={draft.bodyHtml}
            onChange={(event) => setDraft({ ...draft, bodyHtml: event.target.value })}
            rows={16}
            spellCheck={false}
            className={cn(inputClasses, 'font-mono text-xs leading-relaxed')}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="tpl-text" className={fieldLabelClasses}>
            Text body
          </label>
          <textarea
            id="tpl-text"
            value={draft.bodyText}
            onChange={(event) => setDraft({ ...draft, bodyText: event.target.value })}
            rows={9}
            spellCheck={false}
            className={cn(inputClasses, 'font-mono text-xs leading-relaxed')}
          />
        </div>

        <p className="text-xs leading-relaxed text-content-subtle">
          Placeholders: {AVAILABLE_VARIABLES.join(', ')} — replaced when the email is sent. Unused variables render as
          empty text.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={handleSave} disabled={saving || testing || !dirty} size="lg">
            {saving ? 'Saving…' : 'Save template'}
          </Button>
          <Button type="button" variant="secondary" onClick={handleSendTest} disabled={testing || saving} size="lg">
            {testing ? 'Sending…' : `Send test to ${adminEmail}`}
          </Button>
          {dirty ? <span className="text-xs text-content-subtle">Unsaved changes</span> : null}
        </div>

        {saveResult.status === 'ok' ? <OkBanner message={saveResult.message} /> : null}
        {saveResult.status === 'error' ? <ErrorBanner message={saveResult.message} /> : null}
        {testResult.status === 'ok' ? <OkBanner message={testResult.message} /> : null}
        {testResult.status === 'error' ? <ErrorBanner message={testResult.message} /> : null}
      </div>
    </div>
  );
}
