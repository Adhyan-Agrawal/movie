'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { readConsent, subscribeConsent } from '@/lib/consent';

/**
 * Advertising-consent gate (Spec Section 15 / /legal/cookies).
 *
 * Ads must not render before the viewer grants advertising consent. The consent
 * banner stores a granular choice in localStorage (`readConsent().ads`), so this
 * client gate renders its children only while that validated flag is true.
 * Children are passed through as a ReactNode, which means a server component —
 * e.g. <AdSlot> — can sit inside the gate without being converted to a client
 * component.
 *
 * Defaults to hidden; the banner's "Accept all" / "Save choices (ads on)" paths
 * grant it. Server-rendered placeholder text never flashes for non-consenting
 * viewers.
 */
const hasAdsConsent = () => readConsent()?.ads === true;
const serverConsent = () => false;

export function ConsentGate({ children }: { children: ReactNode }) {
  const granted = useSyncExternalStore(subscribeConsent, hasAdsConsent, serverConsent);

  if (!granted) return null;
  return <>{children}</>;
}
