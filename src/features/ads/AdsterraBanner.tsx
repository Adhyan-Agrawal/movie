'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Adsterra banner unit (Spec Section 11) — responsive.
 *
 * The snippet is served as a real document from /api/ad-frame (Adsterra's
 * invoke.js refuses `about:srcdoc` frames — it requires an http(s) location)
 * and embedded with a normal iframe src. Multiple units per page work because
 * each carries its own key+size in the URL.
 *
 * RESPONSIVE: a single iframe is mounted whose dimensions match the current
 * viewport (desktop leaderboard 728×90 vs. mobile 320×50), so ads are
 * customised per PC/mobile view without double-serving one zone key (a
 * matchMedia listener swaps sizes; the initial SSR render shows a sized spacer
 * so no wrong-size request fires before mount).
 *
 * BANNER-ONLY: this component renders display banners only — never popunder,
 * push, or interstitial formats.
 */
export function AdsterraBanner({
  adsterraKey,
  width,
  height,
  mobileWidth,
  mobileHeight,
  className,
}: {
  adsterraKey: string;
  width: number;
  height: number;
  mobileWidth?: number;
  mobileHeight?: number;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia('(max-width: 767px)');
    setIsMobile(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Until the client has measured the viewport, reserve space at the desktop
  // size so layout doesn't jump; only ONE real iframe mounts, after mount.
  if (!mounted) {
    return (
      <div
        aria-hidden="true"
        className={cn('mx-auto', className)}
        style={{ width: '100%', maxWidth: width, height }}
      />
    );
  }

  const w = isMobile && mobileWidth ? mobileWidth : width;
  const h = isMobile && mobileHeight ? mobileHeight : height;
  const src = `/api/ad-frame?key=${encodeURIComponent(adsterraKey)}&w=${w}&h=${h}`;

  return (
    <div
      className={cn('mx-auto flex items-center justify-center', className)}
      style={{ width: '100%', maxWidth: w }}
    >
      <iframe
        title={`Advertisement (${w}×${h})`}
        src={src}
        width={w}
        height={h}
        scrolling="no"
        frameBorder={0}
        className="border-0 bg-transparent"
      />
    </div>
  );
}
