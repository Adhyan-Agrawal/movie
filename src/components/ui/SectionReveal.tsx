'use client';

import { useEffect, useRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { useViewingPreferences } from '@/features/account/ViewingPreferencesProvider';

/** SSR stays visible; offscreen sections and cards reveal once without delaying access. */
export function SectionReveal({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const element = useRef<HTMLDivElement>(null);
  const preferences = useViewingPreferences();

  useEffect(() => {
    const node = element.current;
    if (!node || preferences.reducedMotion || typeof window.matchMedia !== 'function' || typeof IntersectionObserver === 'undefined') return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches) return;
    const targets = [node, ...node.querySelectorAll<HTMLElement>('.shelf-item, .title-grid > li, .title-cast-grid > li')];
    const pending = new Set(targets.filter((target) => target.getBoundingClientRect().top >= window.innerHeight));
    if (!pending.size) return;

    const reveal = () => {
      // Keyboard navigation and a preference change bypass all stagger delays.
      for (const target of targets) target.dataset.revealState = 'complete';
      pending.clear();
      observer.disconnect();
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (!entry.isIntersecting || !pending.delete(target)) continue;
        target.dataset.revealState = 'visible';
        observer.unobserve(target);
      }
      if (!pending.size) observer.disconnect();
    }, { rootMargin: '0px 0px -24px 0px', threshold: 0.01 });
    for (const target of pending) {
      target.dataset.revealState = 'pending';
      observer.observe(target);
    }
    node.addEventListener('focusin', reveal);
    motion.addEventListener('change', reveal, { once: true });
    return () => {
      observer.disconnect();
      for (const target of targets) delete target.dataset.revealState;
      node.removeEventListener('focusin', reveal);
      motion.removeEventListener('change', reveal);
    };
  }, [preferences.reducedMotion]);

  return <div ref={element} className={cn('section-reveal', className)} {...props}>{children}</div>;
}
