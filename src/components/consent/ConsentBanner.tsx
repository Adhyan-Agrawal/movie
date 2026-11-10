'use client';

import { useState, useSyncExternalStore } from 'react';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';
import { readConsent, subscribeConsent, writeConsent, type ConsentChoice } from '@/lib/consent';

export { readConsent, type ConsentChoice } from '@/lib/consent';

/**
 * Cookie/consent banner (Section 15). Stores a granular choice locally.
 * Analytics/ads must not personalize before the relevant consent is granted;
 * subscribers observe saved choices and revocations without remounting.
 */
const hasChoice = () => readConsent() !== null;
const hideUntilHydrated = () => true;

export function ConsentBanner() {
  const decided = useSyncExternalStore(subscribeConsent, hasChoice, hideUntilHydrated);
  const [analytics, setAnalytics] = useState(true);
  const [ads, setAds] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  if (decided) return null;

  function commit(choice: Omit<ConsentChoice, 'necessary' | 'decidedAt'>) {
    const full: ConsentChoice = { necessary: true, decidedAt: new Date().toISOString(), ...choice };
    setSaveFailed(!writeConsent(full));
  }

  return (
    <div
      role="dialog"
      aria-label="Privacy consent"
      aria-modal="false"
      className={cn(
        'fixed inset-x-3 bottom-3 z-50 mx-auto max-w-2xl rounded-lg border border-border-strong',
        'bg-surface-overlay/95 p-4 shadow-raised backdrop-blur-md md:inset-x-auto md:right-6 md:bottom-6',
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">Your privacy</h2>
          <p className="text-xs leading-relaxed text-content-muted">
            We use necessary cookies to run Lumora. With your consent we also use analytics to improve the
            product and, where enabled, advertising. You can change this any time.
          </p>
          {saveFailed ? (
            <p role="status" className="text-xs leading-relaxed text-content-muted">
              Your choice could not be saved. Non-essential features are off in this tab. Allow browser storage
              and try again to save your preference for future visits.
            </p>
          ) : null}
        </div>

        {customize ? (
          <fieldset className="flex flex-col gap-2 rounded-md border border-border bg-surface/60 p-3">
            <legend className="sr-only">Consent options</legend>
            <label className="flex items-center justify-between gap-3 text-xs">
              <span>Strictly necessary</span>
              <input type="checkbox" checked readOnly aria-label="Strictly necessary (always on)" />
            </label>
            <label className="flex items-center justify-between gap-3 text-xs">
              <span>Analytics</span>
              <input
                type="checkbox"
                checked={analytics}
                onChange={(e) => setAnalytics(e.target.checked)}
                aria-label="Analytics consent"
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-xs">
              <span>Advertising</span>
              <input
                type="checkbox"
                checked={ads}
                onChange={(e) => setAds(e.target.checked)}
                aria-label="Advertising consent"
              />
            </label>
          </fieldset>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            className={buttonClasses({ variant: 'ghost', size: 'sm' })}
            onClick={() => commit({ analytics: false, ads: false })}
          >
            Reject non-essential
          </button>
          {customize ? (
            <button
              className={buttonClasses({ variant: 'secondary', size: 'sm' })}
              onClick={() => commit({ analytics, ads })}
            >
              Save choices
            </button>
          ) : (
            <button
              className={buttonClasses({ variant: 'ghost', size: 'sm' })}
              onClick={() => setCustomize(true)}
            >
              Customize
            </button>
          )}
          <button
            className={buttonClasses({ variant: 'primary', size: 'sm' })}
            onClick={() => commit({ analytics: true, ads: true })}
          >
            Accept all
          </button>
        </div>
      </div>
    </div>
  );
}
