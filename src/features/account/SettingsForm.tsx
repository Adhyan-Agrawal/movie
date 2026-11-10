'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Switch } from './Switch';
import { readAccountSettings, writeAccountSettings } from './settings-store';
import { loadAccountPreferencesAction, saveAccountPreferencesAction } from './preference-actions';
import { normalizeAccountSettings, type AccountPreferencesSnapshot } from './preference-types';
import { DEFAULT_SETTINGS, LANGUAGE_OPTIONS, type AccountSettings } from './types';

const selectClass =
  'h-11 w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm text-content ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

function ToggleRow({ label, description, checked, onChange, disabled }: {
  label: string; description: string; checked: boolean; onChange: (value: boolean) => void; disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex flex-col gap-0.5 pr-2">
        <span className="text-sm font-medium text-content">{label}</span>
        <span className="text-sm text-content-muted">{description}</span>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

export interface SettingsFormProps {
  accountId: string;
  initialPreferences?: AccountPreferencesSnapshot | null;
}

/** A new identity gets fresh state before paint, not another account's draft. */
export function SettingsForm(props: SettingsFormProps) {
  return <AccountPreferencesForm key={props.accountId} {...props} />;
}

function AccountPreferencesForm({ accountId, initialPreferences }: SettingsFormProps) {
  const initial = initialPreferences?.accountId === accountId ? initialPreferences : null;
  // Revalidation must not replace this identity's draft or save confirmation.
  const initialRef = useRef(initial);
  const [form, setForm] = useState<AccountSettings>(() => initial ? normalizeAccountSettings(initial.settings) : DEFAULT_SETTINGS);
  const [ready, setReady] = useState(Boolean(initial));
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const activeRef = useRef<object | null>(null);
  const savingRef = useRef(false);
  const languageId = useId();

  useEffect(() => {
    const active = {};
    activeRef.current = active;
    savingRef.current = false;
    setSaving(false);
    setReady(false);
    setLoadError(null);
    setSaveError(null);
    setNotice(null);
    void (async () => {
      try {
        const result = attempt === 0 && initialRef.current
          ? { ok: true as const, snapshot: initialRef.current }
          : await loadAccountPreferencesAction(accountId);
        if (activeRef.current !== active) return;
        if (!result.ok || result.snapshot.accountId !== accountId) {
          setForm(DEFAULT_SETTINGS);
          setLoadError(result.ok ? 'Your account changed. Refresh to load preferences.' : result.message);
          return;
        }
        const browser = !result.snapshot.hasSavedPreferences ? readAccountSettings(accountId) : null;
        setForm(browser ?? normalizeAccountSettings(result.snapshot.settings));
        setLegacy(Boolean(browser));
        setReady(true);
      } catch {
        if (activeRef.current === active) setLoadError('Could not load account preferences. Please try again.');
      }
    })();
    return () => { if (activeRef.current === active) activeRef.current = null; };
  }, [accountId, attempt]);

  function update<K extends keyof AccountSettings>(key: K, value: AccountSettings[K]) {
    if (!ready || savingRef.current) return;
    setForm((previous) => ({ ...previous, [key]: value }));
    setNotice(null);
    setSaveError(null);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const active = activeRef.current;
    if (!active || !ready || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const result = await saveAccountPreferencesAction(accountId, form);
      if (activeRef.current !== active) return;
      if (!result.ok || result.snapshot.accountId !== accountId) {
        setSaveError(result.ok ? 'Your account changed. Refresh before saving.' : `Save not confirmed. ${result.message}`);
        return;
      }
      setForm(normalizeAccountSettings(result.snapshot.settings));
      const cached = writeAccountSettings(accountId, result.snapshot.settings);
      setLegacy(false);
      setNotice(cached ? 'Saved to your account.' : 'Saved to your account. This browser could not keep a local cache.');
    } catch {
      if (activeRef.current === active) setSaveError('Could not confirm saved preferences. Please try again.');
    } finally {
      if (activeRef.current === active) { savingRef.current = false; setSaving(false); }
    }
  }

  const disabled = !ready || saving;
  return (
    <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-8" aria-busy={saving || (!ready && !loadError)}>
      <div className="rounded-lg border border-border bg-surface/40 px-4 py-3 text-xs text-content-muted">
        Preferences sync to <span className="font-medium text-content">your signed-in account</span> after a confirmed save.
        Autoplay next applies to verified native episodes outside Watch Party. Track defaults apply when a matching
        native track is offered; preview and motion choices apply to browsing.
      </div>
      {!ready && !loadError ? <p role="status" className="text-sm text-content-muted">Loading account preferences...</p> : null}
      {loadError ? <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="text-sm text-danger">{loadError}</p>
        <Button type="button" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Retry loading preferences</Button>
      </div> : null}
      {legacy ? <p className="text-sm text-content-muted">Your previous browser choices are shown. Save preferences to sync them to your account.</p> : null}

      <fieldset disabled={disabled}>
        <legend className="mb-3 text-sm font-semibold text-content">Playback language</legend>
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface/40 p-5">
          <label htmlFor={languageId} className="text-sm font-medium">Preferred audio and subtitle language</label>
          <select id={languageId} value={form.language} onChange={(event) => update('language', event.target.value)} className={selectClass}>
            {LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <p className="text-xs text-content-subtle">Used for offered native audio and subtitle tracks without replacing your manual choices. The interface remains English; external embeds control their own tracks.</p>
        </div>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend className="mb-3 text-sm font-semibold text-content">Playback</legend>
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface/40 px-5">
          <ToggleRow label="Autoplay next episode" description="Play the next verified episode when native playback ends. Not used in Watch Party or external embeds."
            checked={form.autoplayNext} onChange={(value) => update('autoplayNext', value)} disabled={disabled} />
          <ToggleRow label="Autoplay previews" description="Allow muted previews after hovering a title. Disabled previews make no automatic trailer requests."
            checked={form.autoplayPreviews} onChange={(value) => update('autoplayPreviews', value)} disabled={disabled} />
          <ToggleRow label="Captions by default" description="Select matching offered subtitles when native playback opens. Manual subtitle choices remain yours."
            checked={form.captions} onChange={(value) => update('captions', value)} disabled={disabled} />
        </div>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend className="mb-3 text-sm font-semibold text-content">Accessibility</legend>
        <div className="rounded-lg border border-border bg-surface/40 px-5">
          <ToggleRow label="Reduce motion" description="Reduce interface animation and stop automatic carousel movement. Your device's reduced-motion setting is always respected."
            checked={form.reducedMotion} onChange={(value) => update('reducedMotion', value)} disabled={disabled} />
        </div>
      </fieldset>

      <p className="text-sm text-content-muted">
        Maturity limits belong to <Link href="/account/profiles" className="text-primary underline">Profiles</Link>, not editable preference metadata.
        Profile PIN locks are not available here.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={disabled}>{saving ? 'Saving preferences...' : 'Save preferences'}</Button>
        {notice ? <p role="status" className="text-sm text-success">{notice}</p> : null}
        {saveError ? <p role="alert" className="text-sm text-danger">{saveError}</p> : null}
      </div>
    </form>
  );
}
