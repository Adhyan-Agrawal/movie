'use client';

import { useEffect } from 'react';

/**
 * Registers the PWA service worker (public/sw.js).
 *
 * Production only: in dev a service worker's cache sits between you and every
 * hot reload, which causes stale-module confusion — so it is skipped there.
 * Registration is deferred to window load so it never competes with the first
 * paint, and any failure is swallowed (the app works fine without it).
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Non-fatal: installability/offline are progressive enhancements.
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
