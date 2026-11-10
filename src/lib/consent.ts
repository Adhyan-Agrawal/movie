'use client';

const STORAGE_KEY = 'lumora.consent.v1';
const CHANGE_EVENT = 'lumora:consent-change';

export interface ConsentChoice {
  necessary: true;
  analytics: boolean;
  ads: boolean;
  decidedAt: string;
}

// A failed revocation must not fall back to a previously saved grant in this tab.
// Only a successful explicit save clears this fail-closed override.
let writeFailed = false;

function parseConsent(raw: string | null): ConsentChoice | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { necessary, analytics, ads, decidedAt } = value as Partial<ConsentChoice>;
    if (necessary !== true || typeof analytics !== 'boolean' || typeof ads !== 'boolean'
      || typeof decidedAt !== 'string' || !Number.isFinite(Date.parse(decidedAt))) return null;
    return { necessary, analytics, ads, decidedAt };
  } catch {
    return null;
  }
}

export function readConsent(): ConsentChoice | null {
  if (typeof window === 'undefined' || writeFailed) return null;
  try {
    return parseConsent(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Persist an explicit choice (null revokes it), notify this tab, and report persistence. */
export function writeConsent(choice: ConsentChoice | null): boolean {
  if (typeof window === 'undefined') return false;
  writeFailed = true;
  try {
    const raw = choice === null ? null : JSON.stringify(choice);
    if (raw !== null && !parseConsent(raw)) throw new TypeError('Invalid consent choice.');
    const storage = window.localStorage;
    if (raw === null) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, raw);
    writeFailed = storage.getItem(STORAGE_KEY) !== raw;
  } catch {
    // Keep non-essential features off even if an older grant remains in storage.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return !writeFailed;
}

/** Re-read consent in the callback; event payloads never grant permission. */
export function subscribeConsent(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
    } catch {
      // A denied read also needs to close any currently mounted consent gate.
    }
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', listener);
  window.addEventListener('pageshow', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', listener);
    window.removeEventListener('pageshow', listener);
  };
}
