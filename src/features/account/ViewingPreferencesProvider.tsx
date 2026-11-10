'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountPreferencesSnapshot } from './preference-types';
import type { AccountSettings } from './types';
import { ACCOUNT_SETTINGS_EVENT, getAccountSettingsAcknowledgement, readAccountSettings, settingsStorageKey } from './settings-store';

const guestPreferences = { autoplayPreviews: true, reducedMotion: false };
const unavailablePreferences = { autoplayPreviews: false, reducedMotion: false };
const ViewingPreferences = createContext(guestPreferences);

export function useViewingPreferences() {
  return useContext(ViewingPreferences);
}

export function ViewingPreferencesProvider({ mode, initialPreferences = null, children }: {
  mode: 'guest' | 'account' | 'unavailable';
  initialPreferences: AccountPreferencesSnapshot | null;
  children: ReactNode;
}) {
  const latest = useRef(initialPreferences);
  latest.current = initialPreferences;
  const [update, setUpdate] = useState<{ basis: AccountPreferencesSnapshot; settings: AccountSettings } | null>(null);
  const owner = mode === 'account' ? initialPreferences?.accountId : undefined;
  const settings = update?.basis === initialPreferences ? update.settings : initialPreferences?.settings;
  const value = mode === 'guest' ? guestPreferences : owner && settings
    ? { autoplayPreviews: settings.autoplayPreviews, reducedMotion: settings.reducedMotion } : unavailablePreferences;

  useEffect(() => {
    if (!owner) return;
    let observed = getAccountSettingsAcknowledgement(owner)?.version ?? 0;
    const apply = (next: AccountSettings | null) => {
      const basis = latest.current;
      if (next && basis?.accountId === owner) setUpdate({ basis, settings: next });
    };
    const acknowledged = () => {
      const saved = getAccountSettingsAcknowledgement(owner);
      if (!saved || saved.version <= observed) return;
      observed = saved.version;
      apply(saved.settings);
    };
    const storage = (event: StorageEvent) => {
      if (event.key !== settingsStorageKey(owner)) return;
      try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
      apply(readAccountSettings(owner));
    };
    window.addEventListener(ACCOUNT_SETTINGS_EVENT, acknowledged);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener(ACCOUNT_SETTINGS_EVENT, acknowledged);
      window.removeEventListener('storage', storage);
    };
  }, [owner]);

  return <ViewingPreferences.Provider value={value}>
    <div className="contents" data-viewing-motion={value.reducedMotion ? 'reduce' : undefined}>{children}</div>
  </ViewingPreferences.Provider>;
}
