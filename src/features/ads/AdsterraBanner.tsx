'use client';

import { cn } from '@/lib/cn';

/**
 * Adsterra banner unit (Spec Section 11).
 *
 * The snippet is served as a real document from /api/ad-frame (Adsterra's
 * invoke.js refuses `about:srcdoc` frames — it requires an http(s) location)
 * and embedded with a normal iframe src. Multiple units per page work because
 * each carries its own key+size in the URL.
 *
 * If the zone key is missing the parent renders a labeled placeholder instead
 * (see AdSlot); this component is only used with a real key.
 */
export function AdsterraBanner({
  adsterraKey,
  width,
  height,
  className,
}: {
  adsterraKey: string;
  width: number;
  height: number;
  className?: string;
}) {
  const src = `/api/ad-frame?key=${encodeURIComponent(adsterraKey)}&w=${width}&h=${height}`;

  return (
    <div
      className={cn('mx-auto flex items-center justify-center', className)}
      style={{ width: '100%', maxWidth: width }}
    >
      <iframe
        title={`Advertisement (${width}×${height})`}
        src={src}
        width={width}
        height={height}
        scrolling="no"
        frameBorder={0}
        className="border-0 bg-transparent"
      />
    </div>
  );
}
