'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { buttonClasses } from '@/components/ui/Button';

/**
 * Install prompt (PWA layer). Chrome/Android fire `beforeinstallprompt`; we
 * cancel it, hold the event, and replay it from the Install button so the
 * browser sheet opens on a user gesture. iOS Safari never fires it, so there
 * we fall back to a one-line Share → Add to Home Screen hint. The banner stays
 * out of the way once the app is installed or the user has said no, and hides
 * itself the moment `appinstalled` lands.
 */

/** The non-standard event Chrome fires when the app becomes installable. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'lumora:install-dismissed';

function markDismissed() {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* storage unavailable — the banner just comes back next session */
  }
}

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    // No storage: stay quiet rather than nag on every page load.
    return true;
  }
}

/** Already running from the home screen — nothing to offer. */
function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS predates the display-mode query and sets this flag instead.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iOS/iPadOS Safari, where `beforeinstallprompt` is never dispatched. */
function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;
  // iPadOS 13+ masquerades as desktop Safari, hence the touch-points check.
  const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && window.navigator.maxTouchPoints > 1);
  return ios && !/crios|fxios|edgios/i.test(ua);
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (wasDismissed() || isStandalone()) return;

    const onBeforeInstall = (event: Event) => {
      // Cancelling suppresses Chrome's own mini-infobar in favour of ours.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      markDismissed();
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    // No install event is coming on iOS — show the manual instruction.
    if (isIosSafari()) {
      setIosHint(true);
      setVisible(true);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  function dismiss() {
    setVisible(false);
    markDismissed();
  }

  async function install() {
    if (!deferred) return;
    const promptEvent = deferred;
    // The event is single-use: drop it now, whatever the outcome.
    setDeferred(null);
    try {
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      if (outcome === 'accepted') setVisible(false); // appinstalled persists it
      else dismiss(); // backed out of the sheet — treat as "not now"
    } catch {
      // Prompt unavailable (already installed, or too soon after a dismissal).
      dismiss();
    }
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Install app"
      className={cn(
        // Clears the fixed bottom nav (56px + its inset) and the home indicator.
        'fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 mx-auto flex items-center gap-3',
        'rounded-lg border border-border-strong bg-surface-overlay/95 p-3 shadow-raised backdrop-blur-md',
        'md:inset-x-auto md:right-6 md:bottom-6',
      )}
    >
      <p className={cn('min-w-0', iosHint ? 'text-xs leading-relaxed text-content-muted' : 'text-sm font-medium')}>
        {iosHint ? 'Tap Share → Add to Home Screen' : 'Install Lumora'}
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button className={buttonClasses({ variant: 'ghost', size: 'sm' })} onClick={dismiss}>
          {iosHint ? 'Got it' : 'Not now'}
        </button>
        {!iosHint ? (
          <button className={buttonClasses({ variant: 'primary', size: 'sm' })} onClick={install}>
            Install
          </button>
        ) : null}
      </div>
    </div>
  );
}
