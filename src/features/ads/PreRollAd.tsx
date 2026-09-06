'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { AdsterraBanner } from './AdsterraBanner';

/**
 * Player pre-roll gate (Spec Sections 9 & 11). After the viewer accepts the
 * external-provider consent, the pre-roll ad plays ABOVE the player for
 * `SKIP_AFTER_SECONDS`, then a "Skip ad" button unlocks playback. The provider
 * iframe mounts only after the ad is skipped — one ad per tab session
 * (sessionStorage), always skippable, never blocking.
 *
 * The Adsterra zone key arrives as a prop from the server (env vars are
 * stripped from client bundles); this component only embeds Adsterra's public
 * banner pattern.
 */
const SKIP_AFTER_SECONDS = 5;

export function PreRollAd({
  adsterraKey,
  width,
  height,
  titleName,
  onDone,
}: {
  adsterraKey: string;
  width: number;
  height: number;
  titleName: string;
  onDone: () => void;
}) {
  const [remaining, setRemaining] = useState(SKIP_AFTER_SECONDS);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (remaining <= 0) return;
    const t = setTimeout(() => setRemaining((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining]);

  function skip() {
    setDismissed(true);
    onDone();
  }

  if (dismissed) return null;

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-base/95 p-4 backdrop-blur-sm">
      <p className="text-xs uppercase tracking-widest text-content-subtle">
        Advertisement · your video starts after this ad
      </p>

      <AdsterraBanner adsterraKey={adsterraKey} width={width} height={height} />

      <div className="flex flex-col items-center gap-2">
        {remaining > 0 ? (
          <p className="text-sm text-content-muted" aria-live="polite">
            You can skip this ad in {remaining}…
          </p>
        ) : (
          <Button variant="secondary" onClick={skip} autoFocus>
            <span aria-hidden="true">▸</span> Skip ad
          </Button>
        )}
        <p className="max-w-md text-center text-xs text-content-subtle">
          Ads keep {`${titleName}`} and the rest of the catalog free. Skipping is always available.
        </p>
      </div>
    </div>
  );
}
