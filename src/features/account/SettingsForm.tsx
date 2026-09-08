'use client';

import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { Switch } from './Switch';
import { readAccountSettings, writeAccountSettings } from './settings-store';
import { DEFAULT_SETTINGS, LANGUAGE_OPTIONS, MATURITY_LEVELS, type AccountSettings } from './types';

const selectClass =
  'h-11 w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm text-content ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

/** Small "stored for the future, not wired yet" marker used on not-live groups. */
function ComingSoon() {
  return (
    <span className="ml-2 align-middle text-[11px] font-medium uppercase tracking-wide text-content-subtle">
      Coming soon
    </span>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex flex-col gap-0.5 pr-2">
        <span className="text-sm font-medium text-content">{label}</span>
        <span className="text-sm text-content-muted">{description}</span>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

/**
 * Preferences form (Spec Section 4).
 *
 * Persistence is browser-local, keyed per signed-in account (see
 * ./settings-store for why there is no server write yet). The form hydrates
 * after mount from this browser's store and reports saves honestly — nothing
 * here claims the server stored the values. Controls whose behavior isn't
 * wired to the app yet are marked "Coming soon"; their choices are still
 * remembered for when the feature ships.
 */
export function SettingsForm({ accountId }: { accountId: string }) {
  const [form, setForm] = useState<AccountSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const languageId = useId();
  const maturityId = useId();

  // localStorage is not available during SSR, so hydrate after mount. Re-read
  // when the signed-in account changes (another user on this browser).
  useEffect(() => {
    setForm(readAccountSettings(accountId));
    setSaved(false);
    setHydrated(true);
  }, [accountId]);

  function update<K extends keyof AccountSettings>(key: K, value: AccountSettings[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
    setSaved(false);
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated) return;
    writeAccountSettings(accountId, form);
    setSaved(true);
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-8">
      <div className="rounded-lg border border-border bg-surface/40 px-4 py-3 text-xs text-content-muted">
        Preferences are saved to <span className="font-medium text-content">this browser</span> for this account and
        are not synced to other devices yet. Options marked <span className="font-medium text-content">Coming soon</span>{' '}
        are stored now and will apply once the matching feature is enabled.
      </div>

      <fieldset>
        <legend className="mb-3 text-sm font-semibold text-content">
          Language and maturity
          <ComingSoon />
        </legend>
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface/40 p-5">
          <div className="flex flex-col gap-2">
            <label htmlFor={languageId} className="text-sm font-medium">
              Display language
            </label>
            <select
              id={languageId}
              value={form.language}
              onChange={(event) => update('language', event.target.value)}
              className={selectClass}
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-content-subtle">
              English is the only available UI language today; other choices are remembered for when localized UI ships.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={maturityId} className="text-sm font-medium">
              Default maturity level
            </label>
            <select
              id={maturityId}
              value={form.maturity}
              onChange={(event) => update('maturity', event.target.value as AccountSettings['maturity'])}
              className={selectClass}
            >
              {MATURITY_LEVELS.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label} — {level.description}
                </option>
              ))}
            </select>
            <p className="text-xs text-content-subtle">
              Maturity limits currently apply per profile — set them on the Profiles page. This default is saved for
              when account-level content gating ships.
            </p>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-sm font-semibold text-content">
          Playback
          <ComingSoon />
        </legend>
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface/40 px-5">
          <ToggleRow
            label="Autoplay next episode"
            description="Automatically play the next episode in a series."
            checked={form.autoplayNext}
            onChange={(value) => update('autoplayNext', value)}
          />
          <ToggleRow
            label="Autoplay previews"
            description="Play trailers and previews while browsing."
            checked={form.autoplayPreviews}
            onChange={(value) => update('autoplayPreviews', value)}
          />
          <ToggleRow
            label="Captions by default"
            description="Turn on subtitles and captions when available."
            checked={form.captions}
            onChange={(value) => update('captions', value)}
          />
        </div>
        <p className="mt-2 text-xs text-content-subtle">
          These playback controls are saved as preferences but aren&apos;t applied to the player yet.
        </p>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-sm font-semibold text-content">
          Accessibility
          <ComingSoon />
        </legend>
        <div className="flex flex-col rounded-lg border border-border bg-surface/40 px-5">
          <ToggleRow
            label="Reduce motion"
            description="Minimize animations and parallax. Your device’s system setting is always respected."
            checked={form.reducedMotion}
            onChange={(value) => update('reducedMotion', value)}
          />
        </div>
        <p className="mt-2 text-xs text-content-subtle">
          Your device’s reduced-motion setting is honored today; this in-app toggle is stored for when motion overrides
          ship.
        </p>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-sm font-semibold text-content">
          Profile lock
          <ComingSoon />
        </legend>
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface/40 px-5 py-4">
          <span className="text-sm font-medium text-content">Require a PIN to open a profile</span>
          <span className="text-sm text-content-muted">
            Profile PINs aren’t available yet. Until they are, profiles on this account are protected by your Lumora
            sign-in.
          </span>
        </div>
      </fieldset>

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={!hydrated}>
          Save preferences
        </Button>
        <p
          role="status"
          aria-live="polite"
          className={cn('text-sm text-success transition-opacity', saved ? 'opacity-100' : 'opacity-0')}
        >
          {saved ? 'Saved on this browser for this account.' : ''}
        </p>
      </div>
    </form>
  );
}
