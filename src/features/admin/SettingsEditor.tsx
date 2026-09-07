'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Json } from '@/lib/supabase/types';
import type { AdminFeatureFlagRow, AdminSiteSettingRow } from './types';
import { updateFeatureFlagAction, updateSiteSettingAction } from './settings-actions';

/**
 * Generic settings + feature-flag editor (Spec Section 10).
 *
 * Site settings are key/value rows whose `value` is a jsonb — the input type
 * is guessed from the stored value (boolean -> checkbox, number -> number
 * input, everything else -> text), so any setting can be edited without
 * key-specific code. Feature flags are simple on/off toggles. Both write
 * through permission-gated server actions (settings.manage) as the signed-in
 * admin; `router.refresh()` re-reads the live rows on success.
 */

type SettingKind = 'string' | 'boolean' | 'number' | 'json';

function kindOf(raw: Json): SettingKind {
  if (typeof raw === 'boolean') return 'boolean';
  if (typeof raw === 'number') return 'number';
  if (raw === null || typeof raw === 'object') return 'json';
  return 'string';
}

function initialValue(raw: Json): string | boolean | number {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw;
  if (raw === null) return '';
  if (typeof raw === 'object') return JSON.stringify(raw);
  return raw;
}

const inputClasses =
  'h-11 w-full min-w-48 rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle transition-colors hover:border-border-strong focus:border-primary focus-visible:outline-none';

function SettingInput({
  kind,
  value,
  onChange,
}: {
  kind: SettingKind;
  value: string | boolean | number;
  onChange: (next: string | boolean | number) => void;
}) {
  if (kind === 'boolean') {
    return (
      <input
        type="checkbox"
        aria-label="Boolean value"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-5 accent-primary"
      />
    );
  }
  if (kind === 'number') {
    return (
      <input
        type="number"
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        className={inputClasses}
      />
    );
  }
  return (
    <input
      type="text"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      className={inputClasses}
    />
  );
}

function SettingRow({ setting }: { setting: AdminSiteSettingRow }) {
  const router = useRouter();
  const [value, setValue] = useState<string | boolean | number>(() => initialValue(setting.value));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const kind = kindOf(setting.value);

  function save() {
    setError(null);
    startTransition(async () => {
      // Round-trip json-encoded values (objects/arrays/null) back to JSON when
      // the admin edits the raw text; strings stay strings.
      let next: Json = value;
      if (kind === 'json' && typeof value === 'string') {
        try {
          next = JSON.parse(value);
        } catch {
          next = value;
        }
      }
      const result = await updateSiteSettingAction(setting.key, next);
      if (!result.ok) setError(result.error ?? 'Could not save the setting.');
      else router.refresh();
    });
  }

  return (
    <tr className="border-b border-border/60 last:border-0">
      <th scope="row" className="px-3 py-2.5 text-left align-top">
        <code className="font-mono text-content">{setting.key}</code>
        {setting.description ? (
          <span className="block max-w-60 text-xs font-normal text-content-subtle">{setting.description}</span>
        ) : null}
      </th>
      <td className="px-3 py-2.5">
        <SettingInput kind={kind} value={value} onChange={setValue} />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-col items-start gap-1">
          <Button size="sm" disabled={pending} onClick={save}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function FlagRow({ flag }: { flag: AdminFeatureFlagRow }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    setError(null);
    startTransition(async () => {
      const result = await updateFeatureFlagAction(flag.key, !flag.enabled);
      if (!result.ok) setError(result.error ?? 'Could not update the flag.');
      else router.refresh();
    });
  }

  return (
    <tr className="border-b border-border/60 last:border-0">
      <th scope="row" className="px-3 py-2.5 text-left align-top">
        <code className="font-mono text-content">{flag.key}</code>
        {flag.description ? (
          <span className="block max-w-60 text-xs font-normal text-content-subtle">{flag.description}</span>
        ) : null}
      </th>
      <td className="px-3 py-2.5">
        <Badge tone={flag.enabled ? 'success' : 'neutral'}>{flag.enabled ? 'On' : 'Off'}</Badge>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex flex-col items-start gap-1">
          <Button size="sm" variant="secondary" disabled={pending} onClick={toggle}>
            {flag.enabled ? 'Turn off' : 'Turn on'}
          </Button>
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

/** Generic settings editor — site settings as key/value inputs, flags as toggles. */
export function SettingsEditor({
  settings,
  flags,
}: {
  settings: AdminSiteSettingRow[];
  flags: AdminFeatureFlagRow[];
}) {
  return (
    <div className="flex flex-col gap-8">
      <section aria-label="Site settings">
        <h2 className="mb-3 font-display text-lg font-semibold">Site settings</h2>
        {settings.length === 0 ? (
          <EmptyState title="No site settings stored" description="site_settings rows will appear here." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Site settings with editable values</caption>
              <thead>
                <tr className="border-b border-border bg-surface/60 text-left text-xs uppercase tracking-wide text-content-subtle">
                  <th scope="col" className="px-3 py-2.5">
                    Key
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Value
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Save
                  </th>
                </tr>
              </thead>
              <tbody>
                {settings.map((setting) => (
                  <SettingRow key={setting.key} setting={setting} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label="Feature flags">
        <h2 className="mb-3 font-display text-lg font-semibold">Feature flags</h2>
        {flags.length === 0 ? (
          <EmptyState title="No feature flags stored" description="feature_flags rows will appear here." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Feature flags with on/off toggles</caption>
              <thead>
                <tr className="border-b border-border bg-surface/60 text-left text-xs uppercase tracking-wide text-content-subtle">
                  <th scope="col" className="px-3 py-2.5">
                    Key
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    State
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Toggle
                  </th>
                </tr>
              </thead>
              <tbody>
                {flags.map((flag) => (
                  <FlagRow key={flag.key} flag={flag} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
