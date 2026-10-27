'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Auto-advancing hero carousel (Spec Section 4).
 *
 * Cycles the top trending titles (10–15 server-rendered Hero slides) so the
 * home banner surfaces fresh content on every visit. Advances every 6s, pauses
 * on hover/focus/touch, and supports prev/next arrows + dot indicators. Slides
 * are passed as server-rendered children (each is the existing <Hero>), so no
 * catalog logic ships to the client.
 *
 * Accessibility: the region is a carousel (aria-roledescription), the active
 * slide is aria-hidden to the rest of the tree, and the controls have labels.
 * Auto-advance respects prefers-reduced-motion (instant, no timer).
 */

const ADVANCE_MS = 6000;

export function HeroCarousel({ children }: { children: ReactNode[] }) {
  const count = children.length;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [autoplay, setAutoplay] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(true);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  const next = useCallback(() => setIndex((i) => (i + 1) % count), [count]);
  const prev = useCallback(() => setIndex((i) => (i - 1 + count) % count), [count]);

  // Auto-advance unless the viewer is interacting or prefers reduced motion.
  useEffect(() => {
    if (paused || !autoplay || reducedMotion || count <= 1) return;
    const timer = window.setInterval(() => { if (!document.hidden) next(); }, ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [paused, autoplay, reducedMotion, count, next]);

  if (count === 0) return null;

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="Trending titles"
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}
      onTouchStart={() => setAutoplay(false)}
    >
      {/* Slides stacked with a crossfade; only the active one is in the tree. */}
      <div className="relative">
        {children.map((child, i) => (
          <div
            key={i}
            aria-hidden={i === index ? undefined : true}
            inert={i !== index}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${count}`}
            className={cn(
              'transition-opacity duration-700 ease-deliberate motion-reduce:transition-none',
              i === index ? 'relative opacity-100' : 'pointer-events-none absolute inset-0 opacity-0',
            )}
          >
            {child}
          </div>
        ))}
      </div>

      {/* Dots + arrows */}
      <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2">
        <button
          type="button"
          onClick={prev}
          aria-label="Previous trending title"
          className="grid h-11 w-11 place-items-center rounded-full border border-border bg-base/60 text-content backdrop-blur transition-colors hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span aria-hidden="true">←</span>
        </button>

        <div className="flex items-center gap-1.5 rounded-full border border-border bg-base/60 px-3 py-2 backdrop-blur">
          {children.map((_child, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Show trending title ${i + 1} of ${count}`}
              aria-current={i === index}
              onClick={() => setIndex(i)}
              className={cn(
                'grid h-11 w-6 place-items-center rounded-full focus-visible:ring-2 focus-visible:ring-primary',
              )}
            ><span aria-hidden="true" className={cn('h-2 rounded-full motion-safe:transition-all', i === index ? 'w-5 bg-primary' : 'w-2 bg-content-subtle')} /></button>
          ))}
        </div>

        <button
          type="button"
          onClick={next}
          aria-label="Next trending title"
          className="grid h-11 w-11 place-items-center rounded-full border border-border bg-base/60 text-content backdrop-blur transition-colors hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span aria-hidden="true">→</span>
        </button>
        {!reducedMotion ? <button type="button" onClick={() => setAutoplay((value) => !value)} aria-label={autoplay ? 'Pause slideshow' : 'Resume slideshow'} className="min-h-11 rounded-full border border-border bg-base/80 px-3 text-xs text-content focus-visible:ring-2 focus-visible:ring-primary">{autoplay ? 'Pause' : 'Resume'}</button> : null}
      </div>
    </div>
  );
}
