'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/ui/Icon';

/**
 * Auto-advancing hero carousel (Spec Section 4).
 *
 * Cycles the server-rendered trending Hero slides so the
 * home banner surfaces fresh content on every visit. Advances every 6s, pauses
 * on hover/focus/touch, and supports prev/next arrows + dot indicators. Slides
 * are passed as server-rendered children (each is the existing <Hero>), so no
 * catalog logic ships to the client.
 *
 * Accessibility: inactive slides are hidden and inert; controls have labels.
 * Auto-advance respects prefers-reduced-motion (instant, no timer).
 */

const ADVANCE_MS = 6000;

export function HeroCarousel({ children }: { children: ReactNode[] }) {
  const count = children.length;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [autoplay, setAutoplay] = useState(false);
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
  const activeIndex = index % count;

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="Trending titles"
      className="hero-carousel relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}
      onTouchStart={() => setAutoplay(false)}
    >
      {/* A shared grid cell keeps the tallest slide's geometry stable. */}
      <div className="hero-slides" aria-live={paused || !autoplay || reducedMotion ? 'polite' : 'off'}>
        {children.map((child, i) => (
          <div
            key={i}
            aria-hidden={i === activeIndex ? undefined : true}
            inert={i !== activeIndex}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${count}`}
            className={cn(
              'hero-slide transition-opacity duration-500 ease-deliberate motion-reduce:transition-none',
              i === activeIndex ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
            {child}
          </div>
        ))}
      </div>

      {/* Dots + arrows */}
      {count > 1 ? <div className="hero-carousel-controls absolute inset-x-4 bottom-6 z-20">
        <span className="hero-slide-count" aria-hidden="true">{String(activeIndex + 1).padStart(2, '0')}<span> / {String(count).padStart(2, '0')}</span></span>
        <button
          type="button"
          onClick={() => { prev(); setAutoplay(false); }}
          aria-label="Previous trending title"
          className="site-icon-button hero-control-button"
        >
          <Icon name="arrow-left" />
        </button>

        <div className="hero-pagination">
          {children.map((_child, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Show trending title ${i + 1} of ${count}`}
              aria-current={i === activeIndex}
              onClick={() => { setIndex(i); setAutoplay(false); }}
              className="hero-pagination-button"
            ><span aria-hidden="true" className={cn('hero-pagination-mark', i === activeIndex && 'is-active')} /></button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => { next(); setAutoplay(false); }}
          aria-label="Next trending title"
          className="site-icon-button hero-control-button"
        >
          <Icon name="arrow-right" />
        </button>
        {!reducedMotion ? <button type="button" onClick={() => setAutoplay((value) => !value)} aria-label={autoplay ? 'Pause slideshow' : 'Start slideshow'} className="hero-autoplay-button">{autoplay ? 'Pause' : 'Auto'}</button> : null}
      </div> : null}
    </div>
  );
}
