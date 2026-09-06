'use client';

import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { Switch } from './Switch';
import { DEFAULT_SETTINGS, LANGUAGE_OPTIONS, MATURITY_LEVELS, type AccountSettings } from './types';

const selectClass =
  'h-11 w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm text-content ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

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

/** Visual-only 4-digit PIN entry with auto-advance (Section 4 PIN affordance). */
function PinField({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '']);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const setDigit = (index: number, raw: string) => {
    const value = raw.replace(/\D/g, '').slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    if (value && index < 3) refs.current[index + 1]?.focus();
  };

  const onKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      refs.current[index - 1]?.focus();
    }
  };

  const complete = digits.every((digit) => digit !== '');

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-raised/50 p-4">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-content">Enter a 4-digit PIN</legend>
        <div className="flex gap-2">
          {digits.map((digit, index) => (
            <input
              key={index}
              ref={(element) => {
                refs.current[index] = element;
              }}
              value={digit}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={1}
              aria-label={`PIN digit ${index + 1}`}
              onChange={(event) => setDigit(index, event.target.value)}
              onKeyDown={(event) => onKeyDown(index, event)}
              className="h-12 w-11 rounded-md border border-border-strong bg-base text-center text-lg text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={!complete} onClick={onSaved}>
          Save PIN
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Preferences form (Section 4). Local state only — "Save preferences" is a
 * documented no-op that reports success via an aria-live status region. Real
 * persistence lands with the account service + server validation.
 */
export function SettingsForm() {
  const [form, setForm] = useState<AccountSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [pinEnabled, setPinEnabled] = useState(DEFAULT_SETTINGS.pinSet);
  const [showPinEntry, setShowPinEntry] = useState(false);
  const [pinStatus, setPinStatus] = useState('');
  const languageId = useId();
  const maturityId = useId();

  function update<K extends keyof AccountSettings>(key: K, value: AccountSettings[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
    setSaved(false);
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // TODO(account): persist via the account service with server validation.
    setSaved(true);
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-8">
      <fieldset>
        <legend className="mb-3 text-sm font-semibold text-content">Language and maturity</legend>
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
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={maturityId} className="text-sm font-medium">
              Maturity level
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
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-sm font-semibold text-content">Playback</legend>
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
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-sm font-semibold text-content">Accessibility</legend>
        <div className="flex flex-col rounded-lg border border-border bg-surface/40 px-5">
          <ToggleRow
            label="Reduce motion"
            description="Minimize animations and parallax. Your device’s system setting is always respected."
            checked={form.reducedMotion}
            onChange={(value) => update('reducedMotion', value)}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-sm font-semibold text-content">Profile lock</legend>
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface/40 p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 pr-2">
              <span className="text-sm font-medium text-content">Require a PIN</span>
              <span className="text-sm text-content-muted">
                {pinEnabled
                  ? 'A 4-digit PIN is required to open this profile.'
                  : 'Protect this profile with a 4-digit PIN.'}
              </span>
            </div>
            <Switch
              checked={pinEnabled}
              label="Require a PIN to open this profile"
              onChange={(value) => {
                setPinEnabled(value);
                setShowPinEntry(false);
                setPinStatus(value ? '' : 'Profile PIN turned off.');
              }}
            />
          </div>

          {pinEnabled ? (
            showPinEntry ? (
              <PinField
                onSaved={() => {
                  setShowPinEntry(false);
                  setPinStatus('Profile PIN updated.');
                }}
                onCancel={() => setShowPinEntry(false)}
              />
            ) : (
              <div>
                <Button type="button" variant="secondary" size="sm" onClick={() => setShowPinEntry(true)}>
                  {form.pinSet ? 'Change PIN' : 'Set PIN'}
                </Button>
              </div>
            )
          ) : null}

          <p aria-live="polite" className="sr-only">
            {pinStatus}
          </p>
        </div>
      </fieldset>

      <div className="flex items-center gap-4">
        <Button type="submit">Save preferences</Button>
        <p
          role="status"
          aria-live="polite"
          className={cn('text-sm text-success transition-opacity', saved ? 'opacity-100' : 'opacity-0')}
        >
          {saved ? 'Preferences saved.' : ''}
        </p>
      </div>
    </form>
  );
}
