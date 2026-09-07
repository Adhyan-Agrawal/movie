'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { readConsent } from '@/components/consent/ConsentBanner';

/**
 * Advertising-consent gate (Spec Section 15 / /legal/cookies).
 *
 * Ads must not render before the viewer grants advertising consent. The consent
 * banner stores a granular choice in localStorage (`readConsent().ads`), so this
 * client gate renders its (server-rendered) children only once that flag is true.
 * Children are passed through as a ReactNode, which means a server component —
 * e.g. <AdSlot> — can sit inside the gate without being converted to a client
 * component.
 *
 * Defaults to hidden; the banner's "Accept all" / "Save choices (ads on)" paths
 * grant it. Server-rendered placeholder text never flashes for non-consenting
 * viewers.
 */
export function ConsentGate({ children }: { children: ReactNode }) {
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    setGranted(Boolean(readConsent()?.ads));
  }, []);

  if (!granted) return null;
  return <>{children}</>;
}
